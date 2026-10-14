package identitypolicy

import "testing"

// A billing suspension (ADR-0080 §12) closes every workspace operation, reads included, for
// every member; only the owner's BillingRead / BillingWrite stay open, and they still pass
// every identity check. The moderation suspension and the billing one never lift each other.
func TestPolicyBillingSuspension(t *testing.T) {
	all := []Operation{WorkspaceRead, WorkspaceWrite, Realtime, RTC, ManageSSO, ManageOAuth, ManageDirectory, BootstrapLink, OAuthAuthorize, OAuthExchange, OAuthRefresh, OAuthUserInfo, RepairPolicy}
	billingOps := []Operation{BillingRead, BillingWrite}
	for _, mode := range []Mode{Off, Optional, Enforced} {
		t.Run(string(mode), func(t *testing.T) {
			s := validState()
			s.Policy.Mode = mode
			for _, op := range billingOps {
				if d := Evaluate(testNow, s, op); !d.Allowed {
					t.Fatalf("%s without suspension: %+v", op, d)
				}
			}
			s.BillingSuspended = true
			for _, op := range all {
				if d := Evaluate(testNow, s, op); d.Allowed || d.Reason != BillingSuspended {
					t.Fatalf("billing suspension let the owner %s: %+v", op, d)
				}
			}
			for _, op := range billingOps {
				if d := Evaluate(testNow, s, op); !d.Allowed {
					t.Fatalf("owner lost %s: %+v", op, d)
				}
				for _, role := range []string{"member", "admin", "guest"} {
					other := s
					other.BuiltinRole = role
					other.Principal.Guest = role == "guest"
					if d := Evaluate(testNow, other, op); d.Allowed || d.Reason != BillingSuspended {
						t.Fatalf("%s %s: %+v", role, op, d)
					}
					// ADR-0087: a BILLING_TOPUP / MANAGE holder keeps the billing scope (a guest never).
					other.BillingPayer = true
					if d := Evaluate(testNow, other, op); d.Allowed == (role == "guest") {
						t.Fatalf("billing payer %s %s: %+v", role, op, d)
					}
					for _, cop := range all {
						if d := Evaluate(testNow, other, cop); d.Allowed {
							t.Fatalf("billing payer %s got %s under suspension: %+v", role, cop, d)
						}
					}
				}
				stranger := s
				stranger.Member = false
				if d := Evaluate(testNow, stranger, op); d.Allowed || d.Reason != MembershipRequired {
					t.Fatalf("a non-member learns of the suspension: %+v", d)
				}
				bot := s
				bot.Principal.Bot = true
				if d := Evaluate(testNow, bot, op); d.Allowed {
					t.Fatalf("bot %s: %+v", op, d)
				}
			}
			if mode == Enforced {
				// The owner's recovery scope still needs the corporate proof.
				noProof := s
				noProof.Assurance = nil
				if d := Evaluate(testNow, noProof, BillingRead); d.Allowed || d.Reason != SSORequired {
					t.Fatalf("billing scope skipped SSO: %+v", d)
				}
			}
		})
	}
	// Moderation suspension: content writes stay closed; the owner's billing scope is not
	// content and stays open under it (paying never lifts it).
	s := validState()
	s.Policy.Mode = Off
	s.WorkspaceSuspended = true
	if d := Evaluate(testNow, s, WorkspaceWrite); d.Allowed || d.Reason != WorkspaceSuspended {
		t.Fatalf("moderation suspension lifted: %+v", d)
	}
	for _, op := range billingOps {
		if d := Evaluate(testNow, s, op); !d.Allowed {
			t.Fatalf("owner billing under moderation %s: %+v", op, d)
		}
	}
	// Both at once: the billing suspension closes the moderation read exception too.
	s.BillingSuspended = true
	if d := Evaluate(testNow, s, WorkspaceRead); d.Allowed || d.Reason != BillingSuspended {
		t.Fatalf("read exception under billing suspension: %+v", d)
	}
	if d := Evaluate(testNow, s, BillingWrite); !d.Allowed {
		t.Fatalf("owner cannot pay under both suspensions: %+v", d)
	}
}
