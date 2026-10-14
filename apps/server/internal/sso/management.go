package sso

import (
	"context"
	"time"
	"unicode/utf8"

	pb "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitycrypto"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func provider(v pb.IdentityProvider) string {
	switch v {
	case pb.IdentityProvider_IDENTITY_PROVIDER_ENTRA:
		return "entra"
	case pb.IdentityProvider_IDENTITY_PROVIDER_ADFS:
		return "adfs"
	case pb.IdentityProvider_IDENTITY_PROVIDER_GENERIC:
		return "generic"
	}
	return ""
}

// ConnectionView redacts the encrypted secret at the service boundary.
func ConnectionView(c sqlc.WorkspaceIdentityConnection) *pb.IdentityConnection {
	providers := map[string]pb.IdentityProvider{"entra": pb.IdentityProvider_IDENTITY_PROVIDER_ENTRA, "adfs": pb.IdentityProvider_IDENTITY_PROVIDER_ADFS, "generic": pb.IdentityProvider_IDENTITY_PROVIDER_GENERIC}
	statuses := map[string]pb.IdentityConnectionStatus{"draft": pb.IdentityConnectionStatus_IDENTITY_CONNECTION_STATUS_DRAFT, "tested": pb.IdentityConnectionStatus_IDENTITY_CONNECTION_STATUS_TESTED, "active": pb.IdentityConnectionStatus_IDENTITY_CONNECTION_STATUS_ACTIVE, "disabled": pb.IdentityConnectionStatus_IDENTITY_CONNECTION_STATUS_DISABLED}
	out := &pb.IdentityConnection{Id: c.ID.String(), WorkspaceId: c.WorkspaceID.String(), Name: c.Name, Provider: providers[c.Provider], Issuer: c.Issuer, TenantId: c.TenantID, ClientId: c.ClientID, SecretConfigured: len(c.ClientSecretBox) > 0, Version: uint64(max(c.Version, 0)), Status: statuses[c.Status]}
	if c.TestedAt != nil {
		out.TestedAt = timestamppb.New(*c.TestedAt)
	}
	return out
}
func (s *Service) manage(ctx context.Context, q *sqlc.Queries, p identitypolicy.Principal, ws uuid.UUID) (identitypolicy.State, error) {
	if _, err := q.LockOAuthWorkspace(ctx, ws); err != nil {
		return identitypolicy.State{}, err
	}
	if _, err := q.EnsureIdentityPolicy(ctx, ws); err != nil {
		return identitypolicy.State{}, err
	}
	st, err := s.state(ctx, q, p, ws)
	if err != nil {
		return st, err
	}
	if err := s.require(ctx, q, st, identitypolicy.ManageSSO); err != nil {
		return st, err
	}
	return st, nil
}

// PutConnection updates credentials under CAS; immutable issuer changes create a fresh draft.
func (s *Service) PutConnection(ctx context.Context, p identitypolicy.Principal, ws uuid.UUID, req *pb.PutIdentityConnectionRequest) (*pb.IdentityConnection, error) {
	if req == nil || utf8.RuneCountInString(req.Name) < 1 || utf8.RuneCountInString(req.Name) > 100 || len(req.ClientId) > 512 || (req.ClientSecret != nil && (*req.ClientSecret == "" || len(*req.ClientSecret) > 8192)) {
		return nil, ErrInvalid
	}
	candidate := sqlc.WorkspaceIdentityConnection{WorkspaceID: ws, Name: req.Name, Provider: provider(req.Provider), Issuer: req.Issuer, TenantID: req.TenantId, ClientID: req.ClientId, Status: "draft", Version: 1, Scopes: []string{"openid"}}
	if !validIssuer(candidate) {
		return nil, ErrInvalid
	}
	var out *pb.IdentityConnection
	err := s.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := s.manage(ctx, q, p, ws); err != nil {
			return err
		}
		all, err := q.ListIdentityConnections(ctx, ws)
		if err != nil {
			return err
		}
		var previous *sqlc.WorkspaceIdentityConnection
		for i := len(all) - 1; i >= 0; i-- {
			if all[i].DisabledAt == nil {
				previous = &all[i]
				break
			}
		}
		if previous == nil && req.Version != 0 || previous != nil && uint64(max(previous.Version, 0)) != req.Version {
			return ErrChanged
		}
		secret := ""
		sameCredentials := previous != nil && previous.Issuer == candidate.Issuer && previous.ClientID == candidate.ClientID
		if previous != nil && !sameCredentials && len(previous.ClientSecretBox) > 0 && req.ClientSecret == nil {
			return ErrInvalid
		}
		if sameCredentials && (previous.Provider != candidate.Provider || previous.TenantID != candidate.TenantID) {
			return ErrInvalid
		}
		if sameCredentials && len(previous.ClientSecretBox) > 0 {
			plain, err := s.Keys.Open(secretBinding(*previous), previous.ClientSecretBox)
			if err != nil {
				return err
			}
			secret = string(plain)
		}
		if req.ClientSecret != nil {
			secret = *req.ClientSecret
		}
		updating := previous != nil && previous.Issuer == candidate.Issuer && previous.ClientID == candidate.ClientID && previous.Provider == candidate.Provider && previous.TenantID == candidate.TenantID
		if updating {
			st, err := s.state(ctx, q, p, ws)
			if err != nil {
				return err
			}
			if st.Policy.Mode == identitypolicy.Enforced && !st.RecoveryReady {
				return denied(identitypolicy.RecentAuthRequired)
			}
			candidate.ID = previous.ID
			candidate.Version = previous.Version + 1
		} else {
			candidate.ID, err = q.ReserveIdentityID(ctx)
			if err != nil {
				return err
			}
		}
		var box []byte
		if secret != "" {
			box, err = s.Keys.Seal(secretBinding(candidate), []byte(secret))
			if err != nil {
				return err
			}
		}
		var saved sqlc.WorkspaceIdentityConnection
		if updating {
			saved, err = q.UpdateIdentityConnection(ctx, sqlc.UpdateIdentityConnectionParams{WorkspaceID: ws, ID: candidate.ID, ExpectedVersion: previous.Version, Name: candidate.Name, ClientID: candidate.ClientID, Scopes: candidate.Scopes, ClientSecretBox: box})
		} else {
			saved, err = q.CreateIdentityConnection(ctx, sqlc.CreateIdentityConnectionParams{ID: &candidate.ID, WorkspaceID: ws, Name: candidate.Name, Provider: candidate.Provider, Issuer: candidate.Issuer, TenantID: candidate.TenantID, ClientID: candidate.ClientID, Status: "draft", Scopes: candidate.Scopes, ClientSecretBox: box, CreatedBy: &p.UserID})
		}
		if err != nil {
			return err
		}
		if updating {
			if err = Invalidate(ctx, q, ws, nil, "connection_changed"); err != nil {
				return err
			}
		}
		if err = Audit(ctx, q, ws, &p.UserID, "connection_changed", &saved.ID); err != nil {
			return err
		}
		out = ConnectionView(saved)
		return nil
	})
	return out, err
}

// ActivateConnection selects only a successfully tested current revision.
func (s *Service) ActivateConnection(ctx context.Context, p identitypolicy.Principal, ws, connection uuid.UUID, version int64) (*pb.IdentityConnection, error) {
	var out *pb.IdentityConnection
	err := s.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockOAuthWorkspace(ctx, ws); err != nil {
			return err
		}
		st, err := s.state(ctx, q, p, ws)
		if err != nil {
			return err
		}
		if err := s.requireTest(ctx, q, st); err != nil {
			return err
		}
		if st.Policy.Mode == identitypolicy.Enforced && !st.RecoveryReady {
			return denied(identitypolicy.RecentAuthRequired)
		}
		c, err := q.GetIdentityConnectionForUpdate(ctx, sqlc.GetIdentityConnectionForUpdateParams{WorkspaceID: ws, ID: connection})
		now, clockErr := s.boundaryNow(ctx, q)
		if clockErr != nil {
			return clockErr
		}
		if err != nil || c.Version != version || c.TestedVersion == nil || *c.TestedVersion != version || c.TestedAt == nil || !now.Before(c.TestedAt.Add(5*time.Minute)) {
			return classified(err, ErrChanged)
		}
		evidence, err := q.GetRecentIdentityConnectionTest(ctx, sqlc.GetRecentIdentityConnectionTestParams{WorkspaceID: ws, ConnectionID: connection, UserID: &p.UserID, ConnectionVersion: version})
		if err != nil {
			return classified(err, denied(identitypolicy.ScopeDenied))
		}
		var proof completion
		if s.open(evidence, "sso-completion", evidence.ResultBox, &proof) != nil || proof.UserID != p.UserID {
			return denied(identitypolicy.ScopeDenied)
		}
		identity, err := q.GetExternalIdentity(ctx, sqlc.GetExternalIdentityParams{WorkspaceID: ws, ID: proof.IdentityID})
		if err != nil || identity.UserID != p.UserID || identity.ConnectionID != connection || identity.Version != proof.Versions.Identity || identity.Status != "active" || identity.Issuer != c.Issuer || identity.Issuer != proof.Proof.Issuer || identity.Subject != proof.Proof.Subject {
			return classified(err, denied(identitypolicy.ScopeDenied))
		}
		if err := s.requireTest(ctx, q, st); err != nil {
			return err
		}
		if err := s.requireOwnerTestProof(ctx, q, proof.Proof); err != nil {
			return err
		}
		all, err := q.ListIdentityConnections(ctx, ws)
		if err != nil {
			return err
		}
		for _, old := range all {
			if old.Status == "active" && old.ID != c.ID {
				if _, err = q.DisableIdentityConnection(ctx, sqlc.DisableIdentityConnectionParams{WorkspaceID: ws, ID: old.ID}); err != nil {
					return err
				}
			}
		}
		c, err = q.ActivateIdentityConnection(ctx, sqlc.ActivateIdentityConnectionParams{WorkspaceID: ws, ID: connection, Version: version})
		if err != nil {
			return err
		}
		if err = Invalidate(ctx, q, ws, nil, "connection_activated"); err != nil {
			return err
		}
		if err = Audit(ctx, q, ws, &p.UserID, "connection_activated", &c.ID); err != nil {
			return err
		}
		// Revocation can wait on other affected sessions; that wait cannot renew proof.
		if err := s.requireTest(ctx, q, st); err != nil {
			return err
		}
		if err := s.requireOwnerTestProof(ctx, q, proof.Proof); err != nil {
			return err
		}
		out = ConnectionView(c)
		return nil
	})
	return out, err
}

func mode(v pb.IdentityPolicyMode) identitypolicy.Mode {
	switch v {
	case pb.IdentityPolicyMode_IDENTITY_POLICY_MODE_OFF:
		return identitypolicy.Off
	case pb.IdentityPolicyMode_IDENTITY_POLICY_MODE_OPTIONAL:
		return identitypolicy.Optional
	case pb.IdentityPolicyMode_IDENTITY_POLICY_MODE_ENFORCED:
		return identitypolicy.Enforced
	}
	return ""
}

// SetPolicy preserves enforcement on dependency failure and requires owner recovery or both proofs.
func (s *Service) SetPolicy(ctx context.Context, p identitypolicy.Principal, ws uuid.UUID, req *pb.PutIdentityPolicyRequest) error {
	if req == nil || mode(req.Mode) == "" {
		return ErrInvalid
	}
	return s.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockOAuthWorkspace(ctx, ws); err != nil {
			return err
		}
		if _, err := q.EnsureIdentityPolicy(ctx, ws); err != nil {
			return err
		}
		st, err := s.state(ctx, q, p, ws)
		if err != nil {
			return err
		}
		if uint64(max(st.Policy.Version, 0)) != req.Version {
			return ErrChanged
		}
		desired := mode(req.Mode)
		if p.Authority == identitypolicy.Recovery {
			if desired == identitypolicy.Enforced {
				return denied(identitypolicy.ScopeDenied)
			}
			if err := s.require(ctx, q, st, identitypolicy.RepairPolicy); err != nil {
				return err
			}
		} else {
			if err := s.require(ctx, q, st, identitypolicy.ManageSSO); err != nil {
				return err
			}
			if desired == identitypolicy.Enforced {
				if err := s.requireEnforcement(ctx, q, st); err != nil {
					return err
				}
			}
		}
		seconds := st.Policy.MaxAge / time.Second
		if seconds < 300 || seconds > 3600 {
			return ErrInvalid
		}
		if _, err = q.SetIdentityPolicy(ctx, sqlc.SetIdentityPolicyParams{WorkspaceID: ws, ExpectedVersion: st.Policy.Version, Mode: string(desired), AssuranceMaxAgeSeconds: int32(seconds), UpdatedBy: &p.UserID}); err != nil {
			return err
		}
		if err = Invalidate(ctx, q, ws, nil, "policy_changed"); err != nil {
			return err
		}
		return Audit(ctx, q, ws, &p.UserID, "policy_changed", nil)
	})
}
func (s *Service) freshOwner(ctx context.Context, q *sqlc.Queries, p identitypolicy.Principal, ws uuid.UUID) (identitypolicy.State, error) {
	st, err := s.manage(ctx, q, p, ws)
	if err != nil {
		return st, err
	}
	if st.Policy.Mode == identitypolicy.Enforced {
		fresh := st
		fresh.Policy.MaxAge = 5 * time.Minute
		if err := s.require(ctx, q, fresh, identitypolicy.ManageSSO); err != nil {
			return st, err
		}
	}
	return st, nil
}

// RecoveryKit rotates ten one-time hashes after independently proven local ownership.
func (s *Service) RecoveryKit(ctx context.Context, p identitypolicy.Principal, ws uuid.UUID) (*pb.IdentityRecoveryKitResponse, error) {
	out := &pb.IdentityRecoveryKitResponse{}
	err := s.DB.Tx(ctx, func(q *sqlc.Queries) error {
		st, err := s.freshOwner(ctx, q, p, ws)
		if err != nil {
			return err
		}
		// Setup while off/optional is the recovery bootstrap; enforced still requires SSO.
		if st.Principal.Authority != identitypolicy.LocalAccount || st.BuiltinRole != "owner" {
			return denied(identitypolicy.ScopeDenied)
		}
		if _, err = q.DeleteIdentityRecoveryCodes(ctx, ws); err != nil {
			return err
		}
		databaseNow, err := q.IdentityDatabaseNow(ctx)
		if err != nil {
			return err
		}
		deadline := databaseNow.Add(365 * 24 * time.Hour)
		out.ExpiresAt = timestamppb.New(deadline)
		for range 10 {
			code, err := identitycrypto.Secret()
			if err != nil {
				return err
			}
			if _, err = q.CreateIdentityRecoveryCode(ctx, sqlc.CreateIdentityRecoveryCodeParams{WorkspaceID: ws, OwnerID: p.UserID, CodeHash: identitycrypto.Hash(code), ExpiresAt: deadline}); err != nil {
				return err
			}
			out.CodesOnce = append(out.CodesOnce, code)
		}
		return Audit(ctx, q, ws, &p.UserID, "recovery_kit_rotated", nil)
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// Recover cannot read workspace data, mint SSO assurance or issue OAuth grants.
func (s *Service) Recover(ctx context.Context, p identitypolicy.Principal, ws uuid.UUID, code string) (*pb.AuthTokens, error) {
	var tokens *pb.AuthTokens
	err := s.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockOAuthWorkspace(ctx, ws); err != nil {
			return err
		}
		st, err := s.state(ctx, q, p, ws)
		if err != nil {
			return err
		}
		if st.Principal.Authority != identitypolicy.LocalAccount {
			return denied(identitypolicy.ScopeDenied)
		}
		if err := s.require(ctx, q, st, identitypolicy.RepairPolicy); err != nil {
			return err
		}
		if _, err = q.ConsumeIdentityRecoveryCode(ctx, sqlc.ConsumeIdentityRecoveryCodeParams{WorkspaceID: ws, OwnerID: p.UserID, CodeHash: identitycrypto.Hash(code)}); err != nil {
			return classified(err, denied(identitypolicy.ScopeDenied))
		}
		databaseNow, err := q.IdentityDatabaseNow(ctx)
		if err != nil {
			return err
		}
		issued, err := s.issue(ctx, q, IssueRequest{UserID: p.UserID, WorkspaceID: ws, Authority: identitypolicy.Recovery, AuthenticatedAt: databaseNow, ExpiresAt: databaseNow.Add(10 * time.Minute)})
		if err != nil {
			return err
		}
		tokens = issued.Tokens
		return Audit(ctx, q, ws, &p.UserID, "recovery_session_issued", &issued.Principal.SessionID)
	})
	return tokens, err
}

// Unlink requires both independent local authentication and fresh corporate proof.
func (s *Service) Unlink(ctx context.Context, p identitypolicy.Principal, ws uuid.UUID) error {
	return s.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockOAuthWorkspace(ctx, ws); err != nil {
			return err
		}
		st, err := s.state(ctx, q, p, ws)
		if err != nil {
			return err
		}
		now, clockErr := s.boundaryNow(ctx, q)
		if clockErr != nil {
			return clockErr
		}
		if err := accessDecision(identitypolicy.CheckGlobal(now, st.Principal, identitypolicy.LinkIdentity, false)); err != nil {
			return err
		}
		fresh := st
		fresh.Policy.Mode = identitypolicy.Enforced
		fresh.Policy.MaxAge = 5 * time.Minute
		if err := s.require(ctx, q, fresh, identitypolicy.WorkspaceRead); err != nil {
			return err
		}
		if st.BuiltinRole == "owner" && (st.Policy.Mode == identitypolicy.Enforced || !st.RecoveryReady) {
			return denied(identitypolicy.ScopeDenied)
		}
		c, err := q.GetActiveIdentityConnection(ctx, ws)
		if err != nil {
			return err
		}
		identity, err := q.FindUserExternalIdentity(ctx, sqlc.FindUserExternalIdentityParams{WorkspaceID: ws, ConnectionID: c.ID, UserID: p.UserID})
		if err != nil {
			return classified(err, ErrNotLinked)
		}
		if _, err = q.SetExternalIdentityStatus(ctx, sqlc.SetExternalIdentityStatusParams{WorkspaceID: ws, ID: identity.ID, Status: "unlinked"}); err != nil {
			return err
		}
		if err = Invalidate(ctx, q, ws, &p.UserID, "identity_unlinked"); err != nil {
			return err
		}
		return Audit(ctx, q, ws, &p.UserID, "identity_unlinked", &identity.ID)
	})
}

// Status exposes only the caller's proof; owner config is always redacted.
func (s *Service) Status(ctx context.Context, p identitypolicy.Principal, ws uuid.UUID) (*pb.GetWorkspaceIdentityResponse, error) {
	st, err := s.loader(s.DB.Q).LoadIdentityState(ctx, p.SessionID, p.UserID, ws)
	if err != nil {
		return nil, err
	}
	if err := s.live(ctx, s.DB.Q, st.Principal); err != nil {
		return nil, err
	}
	if !st.Member {
		return nil, denied(identitypolicy.MembershipRequired)
	}
	if st.Principal.Authority != identitypolicy.LocalAccount && st.Principal.WorkspaceID != ws {
		return nil, denied(identitypolicy.ScopeDenied)
	}
	modes := map[identitypolicy.Mode]pb.IdentityPolicyMode{identitypolicy.Off: pb.IdentityPolicyMode_IDENTITY_POLICY_MODE_OFF, identitypolicy.Optional: pb.IdentityPolicyMode_IDENTITY_POLICY_MODE_OPTIONAL, identitypolicy.Enforced: pb.IdentityPolicyMode_IDENTITY_POLICY_MODE_ENFORCED}
	out := &pb.GetWorkspaceIdentityResponse{Access: &pb.WorkspaceIdentityAccess{WorkspaceId: ws.String(), Mode: modes[st.Policy.Mode], PolicyVersion: uint64(max(st.Policy.Version, 0)), MembershipVersion: uint64(max(st.AccessVersion, 0))}}
	decision, err := s.CheckDecision(ctx, s.DB.Q, st, identitypolicy.WorkspaceRead)
	if err != nil {
		return nil, err
	}
	reasons := map[identitypolicy.Reason]pb.IdentityAccessReason{
		identitypolicy.Allowed:             pb.IdentityAccessReason_IDENTITY_ACCESS_REASON_ALLOWED,
		identitypolicy.SSORequired:         pb.IdentityAccessReason_IDENTITY_ACCESS_REASON_SSO_REQUIRED,
		identitypolicy.ScopeDenied:         pb.IdentityAccessReason_IDENTITY_ACCESS_REASON_SCOPE_DENIED,
		identitypolicy.EntitlementRequired: pb.IdentityAccessReason_IDENTITY_ACCESS_REASON_ENTITLEMENT_REQUIRED,
		identitypolicy.DirectoryStale:      pb.IdentityAccessReason_IDENTITY_ACCESS_REASON_DIRECTORY_DENIED,
		identitypolicy.MembershipSuspended: pb.IdentityAccessReason_IDENTITY_ACCESS_REASON_SUSPENDED,
		identitypolicy.WorkspaceSuspended:  pb.IdentityAccessReason_IDENTITY_ACCESS_REASON_SUSPENDED,
		identitypolicy.BillingSuspended:    pb.IdentityAccessReason_IDENTITY_ACCESS_REASON_BILLING_SUSPENDED,
	}
	out.Access.Reason = reasons[decision.Reason]
	if st.Principal.Authority == identitypolicy.Recovery {
		out.Access.Reason = pb.IdentityAccessReason_IDENTITY_ACCESS_REASON_RECOVERY_ONLY
	}
	if decision.Allowed {
		out.Access.ValidUntil = timestamppb.New(decision.ValidUntil)
	}
	out.Access.Entitlements = &pb.WorkspaceIdentityEntitlements{Version: uint64(max(st.EntitlementVersion, 0))}
	now, err := s.boundaryNow(ctx, s.DB.Q)
	if err != nil {
		return nil, err
	}
	features := []struct {
		feature identitypolicy.Feature
		wire    pb.IdentityFeature
	}{{identitypolicy.SSO, pb.IdentityFeature_IDENTITY_FEATURE_CORPORATE_SSO}, {identitypolicy.DirectorySync, pb.IdentityFeature_IDENTITY_FEATURE_DIRECTORY_SYNC}, {identitypolicy.OAuthProvider, pb.IdentityFeature_IDENTITY_FEATURE_OAUTH_PROVIDER}}
	for _, f := range features {
		grant := st.Grants[f.feature]
		source := pb.IdentityGrantSource_IDENTITY_GRANT_SOURCE_UNSPECIFIED
		switch grant.Source {
		case "cloud_business":
			source = pb.IdentityGrantSource_IDENTITY_GRANT_SOURCE_CLOUD_BUSINESS
		case "onprem_enterprise":
			source = pb.IdentityGrantSource_IDENTITY_GRANT_SOURCE_ONPREM_ENTERPRISE
		}
		item := &pb.IdentityEntitlement{Feature: f.wire, Source: source, Version: uint64(max(grant.Version, 0)), Enabled: identitypolicy.RequireEntitlement(now, ws, grant, f.feature).Allowed}
		if !grant.ValidUntil.IsZero() {
			item.ValidUntil = timestamppb.New(grant.ValidUntil)
		}
		out.Access.Entitlements.Grants = append(out.Access.Entitlements.Grants, item)
	}
	if st.Assurance != nil && !st.Assurance.Revoked {
		out.Access.Assurance = &pb.WorkspaceAssurance{WorkspaceId: ws.String(), AuthenticatedAt: timestamppb.New(st.Assurance.AuthenticatedAt), ExpiresAt: timestamppb.New(st.Assurance.ValidUntil), PolicyVersion: uint64(max(st.Assurance.Versions.Policy, 0)), ConnectionVersion: uint64(max(st.Assurance.Versions.Connection, 0))}
	}
	if st.BuiltinRole == "owner" && st.Principal.Authority == identitypolicy.LocalAccount {
		all, err := s.DB.Q.ListIdentityConnections(ctx, ws)
		if err != nil {
			return nil, err
		}
		if len(all) > 0 {
			out.Connection = ConnectionView(all[len(all)-1])
		}
	}
	return out, nil
}
