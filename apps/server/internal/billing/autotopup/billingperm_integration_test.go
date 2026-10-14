//go:build integration

package autotopup_test

import (
	"testing"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing/provider/fake"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/perm"
)

// grantRole gives user a custom role carrying bits; returns the role id.
func (e *env) grantRole(user uuid.UUID, bits perm.Bits) uuid.UUID {
	e.t.Helper()
	pos := int32(e.count(`SELECT max(position) + 1 FROM workspace_roles WHERE workspace_id = $1 AND position < 1000`, e.ws)) //nolint:gosec // few roles
	r, err := e.d.Q.CreateRole(ctx, sqlc.CreateRoleParams{WorkspaceID: e.ws, Name: "Billing " + uuid.NewString()[:8], Position: pos,
		Permissions: int64(bits)}) //nolint:gosec // test bits
	if err != nil {
		e.t.Fatal(err)
	}
	if err := e.d.Q.AddMemberRole(ctx, sqlc.AddMemberRoleParams{WorkspaceID: e.ws, UserID: user, RoleID: r.ID}); err != nil {
		e.t.Fatal(err)
	}
	return r.ID
}

func (e *env) outbox(user uuid.UUID, template mail.Template) int {
	return e.count(`SELECT count(*) FROM mail_outbox o JOIN users u ON u.email = o.to_addr WHERE u.id = $1 AND o.template = $2`, user, string(template))
}

// ADR-0087: a consent given by a BILLING_MANAGE holder charges; one given by a member without
// it (or whose role was taken away) is revoked at dispatch with permission_lost.
func TestConsentOfBillingManager(t *testing.T) {
	e := newEnv(t, opts{})
	e.grantRole(e.member, perm.BillingManage)
	e.consentAs(e.member)
	e.tick(1)
	if a := e.attempts(); len(a) != 1 || a[0].Status != "succeeded" {
		t.Fatalf("attempts %+v", a)
	}

	e2 := newEnv(t, opts{})
	e2.grantRole(e2.member, perm.BillingTopup) // TOPUP is not enough to consent to charges
	e2.consentAs(e2.member)
	e2.tick(0)
	if c := e2.consentRow(); c.RevokedAt == nil || c.RevokedReason != "permission_lost" {
		t.Fatalf("TOPUP consent %+v", c)
	}

	e3 := newEnv(t, opts{})
	r3 := e3.grantRole(e3.member, perm.BillingManage)
	e3.consentAs(e3.member)
	if err := e3.d.Q.RemoveMemberRole(ctx, sqlc.RemoveMemberRoleParams{WorkspaceID: e3.ws, UserID: e3.member, RoleID: r3}); err != nil {
		t.Fatal(err)
	}
	e3.tick(0)
	if c := e3.consentRow(); c.RevokedAt == nil || c.RevokedReason != "permission_lost" {
		t.Fatalf("revoked role consent %+v", c)
	}
}

// ADR-0087: a failed auto-topup mails the owner and the BILLING_MANAGE holders, not a
// BILLING_VIEW holder; a payment received stays the owner's.
func TestFailedAutoTopupMailsManagers(t *testing.T) {
	e := newEnv(t, opts{})
	viewer := e.user()
	e.addMember(viewer, "member")
	e.grantRole(e.member, perm.BillingManage)
	e.grantRole(viewer, perm.BillingView)
	e.fake.Queue(fake.OpCharge, fake.Decline)
	e.tick(1)
	if e.mails(string(mail.TemplateBillingAutoTopupFailed)) != 1 {
		t.Fatal("one dedup row")
	}
	if e.outbox(e.owner, mail.TemplateBillingAutoTopupFailed) != 1 || e.outbox(e.member, mail.TemplateBillingAutoTopupFailed) != 1 ||
		e.outbox(viewer, mail.TemplateBillingAutoTopupFailed) != 0 {
		t.Fatalf("recipients owner %d manager %d viewer %d", e.outbox(e.owner, mail.TemplateBillingAutoTopupFailed),
			e.outbox(e.member, mail.TemplateBillingAutoTopupFailed), e.outbox(viewer, mail.TemplateBillingAutoTopupFailed))
	}
	e.tick(0) // the same failure is not mailed twice
	if e.outbox(e.member, mail.TemplateBillingAutoTopupFailed) != 1 {
		t.Fatal("dedup")
	}
}
