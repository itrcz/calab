package identitypolicy

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"testing"
	"time"
)

var testNow = time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)

func validState() State {
	ws, user, session, connection, identity := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	versions := Versions{Policy: 2, Access: 2, Connection: 2, Identity: 2, Entitlement: 2, Session: 2}
	s := State{Principal: Principal{UserID: user, SessionID: session, Authority: LocalAccount, LocalAuthenticatedAt: testNow.Add(-time.Minute), ExpiresAt: testNow.Add(24 * time.Hour), Version: 2},
		WorkspaceID: ws, Member: true, BuiltinRole: "owner", AccessVersion: 2, EntitlementVersion: 2, RecoveryReady: true,
		Policy:     Policy{Mode: Enforced, Version: 2, MaxAge: CorporateProofMaxAge},
		Connection: Connection{ID: connection, Version: 2, Enabled: true, Tested: true}, Identity: Identity{ID: identity, ConnectionID: connection, Version: 2, Active: true},
		Assurance: &Assurance{WorkspaceID: ws, UserID: user, SessionID: session, ConnectionID: connection, IdentityID: identity, AuthenticatedAt: testNow.Add(-time.Minute), ValidUntil: testNow.Add(59 * time.Minute), Versions: versions},
		Grants:    map[Feature]Grant{}}
	for _, f := range []Feature{SSO, DirectorySync, OAuthProvider} {
		s.Grants[f] = Grant{WorkspaceID: ws, Feature: f, Source: "cloud_business", Enabled: true, PlanEligible: true, ValidUntil: testNow.Add(2 * time.Hour), Version: 2}
	}
	return s
}
func TestPolicyAllowedOperations(t *testing.T) {
	for _, op := range []Operation{WorkspaceRead, WorkspaceWrite, Realtime, RTC, ManageSSO, ManageOAuth, ManageDirectory, BootstrapLink, OAuthAuthorize, OAuthExchange, OAuthRefresh, OAuthUserInfo, RepairPolicy} {
		t.Run(string(op), func(t *testing.T) {
			s := validState()
			d := Evaluate(testNow, s, op)
			if !d.Allowed || d.Reason != Allowed || !d.ValidUntil.After(testNow) {
				t.Fatalf("%+v", d)
			}
			if d.Lease(testNow).After(testNow.Add(ReadLeaseTTL)) {
				t.Fatal("lease exceeds maximum")
			}
		})
	}
}
func TestPolicyDenials(t *testing.T) {
	cases := []struct {
		name   string
		change func(*State)
		op     Operation
		reason Reason
	}{
		{"unknown authority", func(s *State) { s.Principal.Authority = "" }, WorkspaceRead, InvalidSession},
		{"expired session", func(s *State) { s.Principal.ExpiresAt = testNow }, WorkspaceRead, InvalidSession},
		{"revoked session", func(s *State) { s.Principal.Revoked = true }, WorkspaceRead, InvalidSession},
		{"zero user", func(s *State) { s.Principal.UserID = uuid.Nil }, WorkspaceRead, InvalidSession},
		{"zero session", func(s *State) { s.Principal.SessionID = uuid.Nil }, WorkspaceRead, InvalidSession},
		{"scoped A cannot B", func(s *State) {
			s.Principal.Authority = WorkspaceSSO
			s.Principal.LocalAuthenticatedAt = time.Time{}
			s.Principal.WorkspaceID = uuid.New()
			s.Principal.ConnectionID = s.Connection.ID
		}, WorkspaceRead, ScopeDenied},
		{"local has scope", func(s *State) { s.Principal.WorkspaceID = s.WorkspaceID }, WorkspaceRead, InvalidSession},
		{"missing member", func(s *State) { s.Member = false }, WorkspaceRead, MembershipRequired},
		{"membership tombstone", func(s *State) { s.Suspended = true }, WorkspaceRead, MembershipSuspended},
		{"workspace suspended", func(s *State) { s.WorkspaceSuspended = true }, WorkspaceRead, WorkspaceSuspended},
		{"zero entitlement epoch", func(s *State) { s.EntitlementVersion = 0 }, WorkspaceRead, PolicyInvalid},
		{"zero connection epoch", func(s *State) { s.Connection.Version = 0; s.Assurance.Versions.Connection = 0 }, WorkspaceRead, SSORequired},
		{"zero policy", func(s *State) { s.Policy.Version = 0 }, WorkspaceRead, PolicyInvalid},
		{"unknown mode", func(s *State) { s.Policy.Mode = "testing" }, WorkspaceRead, PolicyInvalid},
		{"unbounded proof config", func(s *State) { s.Policy.MaxAge = 2 * time.Hour }, WorkspaceRead, PolicyInvalid},
		{"missing grant", func(s *State) { delete(s.Grants, SSO) }, WorkspaceRead, EntitlementRequired},
		{"plan expired", func(s *State) { g := s.Grants[SSO]; g.PlanEligible = false; s.Grants[SSO] = g }, WorkspaceRead, EntitlementRequired},
		{"grant expired", func(s *State) { g := s.Grants[SSO]; g.ValidUntil = testNow; s.Grants[SSO] = g }, WorkspaceRead, EntitlementRequired},
		{"grant disabled", func(s *State) { g := s.Grants[SSO]; g.Enabled = false; s.Grants[SSO] = g }, WorkspaceRead, EntitlementRequired},
		{"missing proof", func(s *State) { s.Assurance = nil }, WorkspaceRead, SSORequired},
		{"expired proof", func(s *State) { s.Assurance.ValidUntil = testNow }, WorkspaceRead, SSORequired},
		{"proof future authentication", func(s *State) { s.Assurance.AuthenticatedAt = testNow.Add(time.Second) }, WorkspaceRead, SSORequired},
		{"proof over hour", func(s *State) { s.Assurance.ValidUntil = s.Assurance.AuthenticatedAt.Add(time.Hour + time.Second) }, WorkspaceRead, SSORequired},
		{"revoked proof", func(s *State) { s.Assurance.Revoked = true }, WorkspaceRead, SSORequired},
		{"proof other user", func(s *State) { s.Assurance.UserID = uuid.New() }, WorkspaceRead, SSORequired},
		{"proof other workspace", func(s *State) { s.Assurance.WorkspaceID = uuid.New() }, WorkspaceRead, SSORequired},
		{"proof other session", func(s *State) { s.Assurance.SessionID = uuid.New() }, WorkspaceRead, SSORequired},
		{"proof other identity", func(s *State) { s.Assurance.IdentityID = uuid.New() }, WorkspaceRead, SSORequired},
		{"connection disabled", func(s *State) { s.Connection.Enabled = false }, WorkspaceRead, SSORequired},
		{"connection not tested", func(s *State) { s.Connection.Tested = false }, WorkspaceRead, SSORequired},
		{"identity suspended", func(s *State) { s.Identity.Active = false }, WorkspaceRead, SSORequired},
		{"policy changed", func(s *State) { s.Policy.Version++ }, WorkspaceRead, SSORequired},
		{"membership changed", func(s *State) { s.AccessVersion++ }, WorkspaceRead, SSORequired},
		{"connection changed", func(s *State) { s.Connection.Version++ }, WorkspaceRead, SSORequired},
		{"identity changed", func(s *State) { s.Identity.Version++ }, WorkspaceRead, SSORequired},
		{"entitlement changed", func(s *State) { s.EntitlementVersion++ }, WorkspaceRead, SSORequired},
		{"session changed", func(s *State) { s.Principal.Version++ }, WorkspaceRead, SSORequired},
		{"custom integration role", func(s *State) { s.BuiltinRole = "custom" }, ManageOAuth, RoleRequired},
		{"admin cannot manage SSO", func(s *State) { s.BuiltinRole = "admin" }, ManageSSO, RoleRequired},
		{"admin cannot manage directory", func(s *State) { s.BuiltinRole = "admin" }, ManageDirectory, RoleRequired},
		{"stale local SSO management", func(s *State) { s.Principal.LocalAuthenticatedAt = testNow.Add(-5 * time.Minute) }, ManageSSO, RecentAuthRequired},
		{"stale local directory management", func(s *State) { s.Principal.LocalAuthenticatedAt = testNow.Add(-5 * time.Minute) }, ManageDirectory, RecentAuthRequired},
		{"stale local bootstrap", func(s *State) { s.Principal.LocalAuthenticatedAt = testNow.Add(-5 * time.Minute) }, BootstrapLink, RecentAuthRequired},
		{"scoped SSO management", func(s *State) {
			s.Principal.Authority = WorkspaceSSO
			s.Principal.WorkspaceID = s.WorkspaceID
			s.Principal.ConnectionID = s.Connection.ID
			s.Principal.LocalAuthenticatedAt = time.Time{}
		}, ManageSSO, RecentAuthRequired},
		{"guest OAuth management", func(s *State) { s.Policy.Mode = Optional; s.Principal.Guest = true }, ManageOAuth, ScopeDenied},
		{"OAuth management without entitlement", func(s *State) { delete(s.Grants, OAuthProvider) }, ManageOAuth, EntitlementRequired},
		{"scoped OAuth management without proof", func(s *State) {
			s.Policy.Mode = Optional
			s.Principal.Authority = WorkspaceSSO
			s.Principal.WorkspaceID = s.WorkspaceID
			s.Principal.ConnectionID = s.Connection.ID
			s.Principal.LocalAuthenticatedAt = time.Time{}
			s.Assurance = nil
		}, ManageOAuth, SSORequired},
		{"stale corporate management", func(s *State) {
			s.Assurance.AuthenticatedAt = testNow.Add(-6 * time.Minute)
			s.Assurance.ValidUntil = testNow.Add(54 * time.Minute)
		}, ManageOAuth, SSORequired},
		{"guest OAuth", func(s *State) { s.Policy.Mode = Optional; s.Principal.Guest = true }, OAuthAuthorize, ScopeDenied},
		{"guest-role member OAuth", func(s *State) { s.Policy.Mode = Optional; s.BuiltinRole = "guest" }, OAuthAuthorize, ScopeDenied},
		{"guest-role member OAuth refresh", func(s *State) { s.Policy.Mode = Optional; s.BuiltinRole = "guest" }, OAuthRefresh, ScopeDenied},
		{"guest enforced", func(s *State) { s.BuiltinRole = "guest" }, WorkspaceRead, SSORequired},
		{"bot human session", func(s *State) { s.Principal.Bot = true }, WorkspaceRead, ScopeDenied},
		{"directory stale", func(s *State) {
			s.Directory = Directory{Required: true, Active: true, Enabled: true, ValidUntil: testNow}
		}, WorkspaceRead, DirectoryStale},
		{"directory disabled", func(s *State) {
			s.Directory = Directory{Required: true, Active: true, ValidUntil: testNow.Add(time.Minute)}
		}, WorkspaceRead, DirectoryStale},
		{"directory user disabled", func(s *State) {
			s.Directory = Directory{Required: true, Enabled: true, ValidUntil: testNow.Add(time.Minute)}
		}, WorkspaceRead, DirectoryStale},
		{"unknown operation", func(_ *State) {}, Operation(""), UnknownOperation},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := validState()
			tc.change(&s)
			d := Evaluate(testNow, s, tc.op)
			if d.Allowed || d.Reason != tc.reason || !d.Lease(testNow).IsZero() {
				t.Fatalf("%+v, want %s", d, tc.reason)
			}
		})
	}
}

// TestManageOAuthWithoutRecentPassword pins ADR-0102: OAuth client management needs the
// admin role, entitlement and (for scoped/enforced) the SSO proof, but no fresh password.
func TestManageOAuthWithoutRecentPassword(t *testing.T) {
	for _, mode := range []Mode{Off, Optional} {
		s := validState()
		s.Policy.Mode = mode
		s.Assurance = nil
		s.BuiltinRole = "admin"
		s.Principal.LocalAuthenticatedAt = testNow.Add(-72 * time.Hour)
		d := Evaluate(testNow, s, ManageOAuth)
		if !d.Allowed || !d.ValidUntil.After(testNow.Add(ManagementMaxAge)) {
			t.Fatalf("%s: stale local session denied or leased to the password window: %+v", mode, d)
		}
		s.Principal.LocalAuthenticatedAt = time.Time{}
		if d := Evaluate(testNow, s, ManageOAuth); !d.Allowed {
			t.Fatalf("%s: session without local timestamp denied: %+v", mode, d)
		}
		if d := Evaluate(testNow, s, ManageSSO); d.Allowed || d.Reason != RoleRequired {
			t.Fatalf("%s: admin reached SSO management: %+v", mode, d)
		}
	}
	// Enforced: a stale local password is fine, the fresh SSO proof is still required.
	s := validState()
	s.Principal.LocalAuthenticatedAt = testNow.Add(-time.Hour)
	if d := Evaluate(testNow, s, ManageOAuth); !d.Allowed {
		t.Fatalf("enforced with fresh proof denied: %+v", d)
	}
	// A workspace_sso session manages OAuth clients through its fresh proof.
	s = validState()
	s.Principal.Authority = WorkspaceSSO
	s.Principal.WorkspaceID = s.WorkspaceID
	s.Principal.ConnectionID = s.Connection.ID
	s.Principal.LocalAuthenticatedAt = time.Time{}
	if d := Evaluate(testNow, s, ManageOAuth); !d.Allowed {
		t.Fatalf("scoped session with fresh proof denied: %+v", d)
	}
	s.Assurance.AuthenticatedAt = testNow.Add(-6 * time.Minute)
	if d := Evaluate(testNow, s, ManageOAuth); d.Allowed || d.Reason != SSORequired {
		t.Fatalf("scoped session with stale proof allowed: %+v", d)
	}
}
func TestOptionalAndScopedAuthority(t *testing.T) {
	for _, mode := range []Mode{Off, Optional} {
		s := validState()
		s.Policy.Mode = mode
		s.Assurance = nil
		s.Grants = nil
		if !Evaluate(testNow, s, WorkspaceRead).Allowed {
			t.Fatal("legacy local access regressed")
		}
		s.Principal.Authority = WorkspaceSSO
		s.Principal.WorkspaceID = s.WorkspaceID
		s.Principal.ConnectionID = s.Connection.ID
		s.Principal.LocalAuthenticatedAt = time.Time{}
		if Evaluate(testNow, s, WorkspaceRead).Allowed {
			t.Fatal("scoped session bypassed proof/entitlement")
		}
	}
	s := validState()
	s.Principal.Authority = WorkspaceSSO
	s.Principal.WorkspaceID = s.WorkspaceID
	s.Principal.ConnectionID = s.Connection.ID
	s.Principal.LocalAuthenticatedAt = time.Time{}
	if !Evaluate(testNow, s, WorkspaceRead).Allowed {
		t.Fatal("scoped access denied")
	}
	for _, op := range []Operation{GlobalRead, GlobalWrite, LinkIdentity, ProductAdmin} {
		if CheckGlobal(testNow, s.Principal, op, true).Allowed {
			t.Fatal("corporate proof granted global authority")
		}
	}
}
func TestRecoveryAndBootstrap(t *testing.T) {
	s := validState()
	s.Assurance = nil
	if !Evaluate(testNow, s, BootstrapLink).Allowed {
		t.Fatal("circular bootstrap requirement")
	}
	if EvaluateEnforcement(testNow, s).Allowed {
		t.Fatal("enabled enforcement without proof")
	}
	s = validState()
	s.RecoveryReady = false
	if EvaluateEnforcement(testNow, s).Allowed {
		t.Fatal("enabled enforcement without recovery")
	}
	s = validState()
	s.Principal.Authority = Recovery
	s.Principal.WorkspaceID = s.WorkspaceID
	s.Principal.LocalAuthenticatedAt = time.Time{}
	s.Principal.RecoveryAuthenticatedAt = testNow.Add(-7 * time.Minute)
	s.Principal.ExpiresAt = testNow.Add(3 * time.Minute)
	s.Assurance = nil
	s.Grants = nil
	s.Directory.Required = true
	if !Evaluate(testNow, s, RepairPolicy).Allowed {
		t.Fatal("recovery requires unavailable IdP/subscription")
	}
	for _, op := range []Operation{WorkspaceRead, WorkspaceWrite, Realtime, RTC, OAuthAuthorize, OAuthRefresh, OAuthUserInfo, ManageSSO, ManageOAuth, ManageDirectory, BootstrapLink} {
		if Evaluate(testNow, s, op).Allowed {
			t.Fatalf("recovery granted %s", op)
		}
	}
	s.Principal.RecoveryAuthenticatedAt = testNow.Add(-10 * time.Minute)
	if Evaluate(testNow, s, RepairPolicy).Allowed {
		t.Fatal("expired recovery accepted")
	}
}
func TestPositiveEntitlements(t *testing.T) {
	ws := uuid.New()
	config := EntitlementConfig{Edition: "enterprise", EnterpriseWorkspaceIDs: map[uuid.UUID]bool{ws: true}}
	if config.Eligible(uuid.New(), "onprem_enterprise", true) || config.Eligible(ws, "cloud_business", true) || (EntitlementConfig{}).Eligible(ws, "cloud_business", true) {
		t.Fatal("edition/allowlist fail-open")
	}
	if !config.Eligible(ws, "onprem_enterprise", false) {
		t.Fatal("explicit enterprise grant denied")
	}
	grant := Grant{WorkspaceID: ws, Feature: SSO, Source: "onprem_enterprise", Enabled: true, PlanEligible: true, Version: 1}
	d := RequireEntitlement(testNow, ws, grant, SSO)
	if !d.Allowed || d.ValidUntil.IsZero() {
		t.Fatal("perpetual grant has no finite decision deadline")
	}
	for _, feature := range []Feature{"", DirectorySync, OAuthProvider} {
		if RequireEntitlement(testNow, ws, grant, feature).Allowed {
			t.Fatal("feature grant substituted")
		}
	}
}

type errorLoader struct {
	state State
	err   error
}

func (l errorLoader) LoadIdentityState(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (State, error) {
	return l.state, l.err
}
func TestServiceFailClosed(t *testing.T) {
	s := validState()
	ctx := context.Background()
	var service *Service
	if d, err := service.CheckWorkspace(ctx, s.Principal, s.WorkspaceID, WorkspaceRead); err == nil || d.Allowed {
		t.Fatal("nil service allowed")
	}
	failure := errors.New("database unavailable")
	service = &Service{Loader: errorLoader{err: failure}}
	if d, err := service.CheckWorkspace(ctx, s.Principal, s.WorkspaceID, WorkspaceRead); !errors.Is(err, failure) || d.Allowed {
		t.Fatal("DB failure allowed")
	}
	service = &Service{Loader: errorLoader{state: s}, Now: func() time.Time { return testNow }}
	if d, err := service.CheckWorkspace(ctx, s.Principal, s.WorkspaceID, WorkspaceRead); err != nil || !d.Allowed {
		t.Fatalf("%+v %v", d, err)
	}
	if d, err := service.CheckWorkspace(ctx, s.Principal, uuid.New(), WorkspaceRead); err == nil || d.Allowed {
		t.Fatal("loader scope mismatch allowed")
	}
}

func TestPolicySuspendedWorkspaceLocalReadOnly(t *testing.T) {
	for _, mode := range []Mode{Off, Optional} {
		t.Run(string(mode), func(t *testing.T) {
			s := validState()
			s.Policy.Mode = mode
			s.WorkspaceSuspended = true
			if d := Evaluate(testNow, s, WorkspaceRead); !d.Allowed {
				t.Fatalf("legacy local read lost: %+v", d)
			}
			for _, op := range []Operation{WorkspaceWrite, Realtime, RTC, OAuthAuthorize, OAuthExchange, OAuthRefresh, OAuthUserInfo, ManageSSO, ManageOAuth, ManageDirectory, BootstrapLink, RepairPolicy} {
				if d := Evaluate(testNow, s, op); d.Allowed || d.Reason != WorkspaceSuspended {
					t.Fatalf("read exception authorized %s: %+v", op, d)
				}
			}
			cases := []struct {
				name   string
				change func(*State)
			}{
				{"enforced", func(s *State) { s.Policy.Mode = Enforced }},
				{"scoped", func(s *State) {
					s.Principal.Authority = WorkspaceSSO
					s.Principal.WorkspaceID = s.WorkspaceID
					s.Principal.ConnectionID = s.Connection.ID
				}},
				{"recovery", func(s *State) {
					s.Principal.Authority = Recovery
					s.Principal.WorkspaceID = s.WorkspaceID
					s.Principal.RecoveryAuthenticatedAt = testNow
				}},
				{"bot", func(s *State) { s.Principal.Bot = true }},
				{"revoked session", func(s *State) { s.Principal.Revoked = true }},
				{"expired session", func(s *State) { s.Principal.ExpiresAt = testNow }},
				{"missing membership", func(s *State) { s.Member = false }},
				{"suspended membership", func(s *State) { s.Suspended = true }},
				{"invalid policy", func(s *State) { s.Policy.Version = 0 }},
				{"missing directory entitlement", func(s *State) { s.Directory.Required = true; delete(s.Grants, DirectorySync) }},
				{"disabled directory", func(s *State) {
					s.Directory = Directory{Required: true, Active: true, Enabled: false, ValidUntil: testNow.Add(time.Hour)}
				}},
				{"disabled directory member", func(s *State) {
					s.Directory = Directory{Required: true, Active: false, Enabled: true, ValidUntil: testNow.Add(time.Hour)}
				}},
				{"stale directory", func(s *State) {
					s.Directory = Directory{Required: true, Active: true, Enabled: true, ValidUntil: testNow}
				}},
			}
			for _, c := range cases {
				t.Run(c.name, func(t *testing.T) {
					state := s
					state.Grants = map[Feature]Grant{}
					for feature, grant := range s.Grants {
						state.Grants[feature] = grant
					}
					c.change(&state)
					if d := Evaluate(testNow, state, WorkspaceRead); d.Allowed {
						t.Fatal("suspension read skipped", c.name)
					}
				})
			}
		})
	}
}
