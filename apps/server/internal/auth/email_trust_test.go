package auth

import (
	"os"
	"strings"
	"testing"

	"github.com/calaba/calaba/server/internal/config"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// EmailGate (ADR-0065): the zero value and "required" block an unconfirmed address,
// "optional" lets it through; guests are never blocked; RequireVerified ignores the mode.
func TestEmailGate(t *testing.T) {
	addr := "a@example.com"
	unverified := sqlc.User{Email: &addr}
	guest := sqlc.User{IsGuest: true}
	if (EmailGate{}).Allow(unverified) == nil {
		t.Fatal("zero gate let an unconfirmed address through")
	}
	if NewEmailGate(config.EmailVerificationRequired).Allow(unverified) == nil {
		t.Fatal("required gate let an unconfirmed address through")
	}
	if err := NewEmailGate(config.EmailVerificationOptional).Allow(unverified); err != nil {
		t.Fatalf("optional gate: %v", err)
	}
	if (EmailGate{}).Allow(guest) != nil {
		t.Fatal("guest blocked")
	}
	if RequireVerified(unverified) == nil {
		t.Fatal("RequireVerified let an unconfirmed address through")
	}
	// Who is asked (and mailed a code) unprompted: everyone in the required mode, only the
	// invitee of a waiting email invitation in the optional one.
	for _, c := range []struct {
		v   VerificationState
		ask bool
	}{{VerificationState{}, true}, {VerificationState{Optional: true}, false}, {VerificationState{Optional: true, InvitePending: true}, true}} {
		if c.v.Ask() != c.ask {
			t.Errorf("%+v: Ask() = %v", c.v, !c.ask)
		}
	}
}

// The places that TRUST an address keep checking email_verified_at themselves and never
// consult EMAIL_VERIFICATION (ADR-0065 «Доверие к адресу»): an account registered with
// someone else's address must not be found by email, auto-joined, given email claims or
// superadmin. A refactoring that routes one of them through EmailGate fails here.
func TestEmailTrustInventory(t *testing.T) {
	trust := map[string][]string{
		"../workspaces/email_invites.go": {
			"u.EmailVerifiedAt == nil || u.Email == nil", // addMember: only confirmed accounts
			"auth.RequireVerified(u)",                    // boundInvite: email code joins confirmed only
			"current.EmailVerifiedAt == nil",             // AcceptEmailInvites
		},
		"../oauthprovider/token.go":       {"u.Email != nil && u.EmailVerifiedAt != nil"},
		"../oauthprovider/userinfo.go":    {"u.Email != nil && u.EmailVerifiedAt != nil"},
		"../auth/identity.go":             {"u.EmailVerifiedAt != nil && superadmin.IsPtr(u.Email)"},
		"../auth/identitymutation.go":     {"u.EmailVerifiedAt != nil && superadmin.IsPtr(u.Email)"},
		"../pbconv/pbconv.go":             {"IsSuperadmin:  u.EmailVerifiedAt != nil && superadmin.IsPtr(u.Email)"},
		"../calendar/mailer.go":           {"u.EmailVerifiedAt == nil", "org.EmailVerifiedAt != nil"},
		"../calendar/public.go":           {"u.EmailVerifiedAt != nil"},
		"../db/queries/email_invites.sql": {"WHERE email = $1 AND email_verified_at IS NOT NULL"}, // LookupInvitee
	}
	for file, needles := range trust {
		b, err := os.ReadFile(file) //nolint:gosec // fixed list of repository sources
		if err != nil {
			t.Fatal(err)
		}
		src := string(b)
		for _, n := range needles {
			if !strings.Contains(src, n) {
				t.Errorf("%s: the address check %q is gone", file, n)
			}
		}
		if file == "../workspaces/email_invites.go" {
			// The file also holds the inviter's own gate (verifiedAccount); that must stay the
			// only use of the mode in it.
			at := strings.Index(src, "func (h *Handlers) verifiedAccount(")
			if at < 0 || strings.Count(src, "emailGate") != 1 {
				t.Errorf("%s: EmailGate is used outside verifiedAccount", file)
				continue
			}
			body := src[at:]
			body = body[:strings.Index(body, "\n}\n")]
			if !strings.Contains(body, "h.emailGate.Allow(u)") {
				t.Errorf("%s: EmailGate is used outside verifiedAccount", file)
			}
			continue
		}
		for _, bad := range []string{"EmailGate", "EmailVerificationOptional", "EMAIL_VERIFICATION"} {
			if strings.Contains(src, bad) {
				t.Errorf("%s: trust check depends on %s", file, bad)
			}
		}
	}
}
