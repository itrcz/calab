//go:build integration

package billinghttp_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/perm"
)

func (e *env) emailOf(u uuid.UUID) string {
	e.t.Helper()
	user, err := e.d.Q.GetUser(ctx, u)
	if err != nil || user.Email == nil {
		e.t.Fatal(err)
	}
	return *user.Email
}

// mailsTo counts the queued mails of a template to an address.
func (e *env) mailsTo(tmpl mail.Template, addr string) int {
	return e.count(`SELECT count(*) FROM mail_outbox WHERE template = $1 AND to_addr = $2`, string(tmpl), addr)
}

func (e *env) stopLapsed(at time.Time) {
	e.t.Helper()
	if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_accounts SET status = 'stopped', next_due_at = NULL, lapsed_at = $2 WHERE id = $1`, e.acc, at); err != nil {
		e.t.Fatal(err)
	}
}

// Entering the restricted mode mails the owner and the BILLING_MANAGE holders once per episode
// (ADR-0086 amendment 1, ADR-0087), with what does not fit Free in the recipient's locale; a plain
// member, a VIEW-only holder and a guest get nothing; without enforcement nothing is sent.
func TestBillingLapsedMail(t *testing.T) {
	e := newEnv(t)
	violations := []*v1.PlanLimitViolation{{Kind: v1.PlanLimitKind_PLAN_LIMIT_KIND_MEMBERS, Current: 12, Limit: 10}}
	e.in.Mail.Enforced = true
	e.in.Mail.FreeBlockers = func(context.Context, uuid.UUID) ([]*v1.PlanLimitViolation, error) { return violations, nil }
	manager, viewer := e.holder(perm.BillingManage), e.holder(perm.BillingView)
	if _, err := e.d.Pool.Exec(ctx, `UPDATE users SET locale = 'ru' WHERE id = $1`, manager); err != nil {
		t.Fatal(err)
	}
	owner, mgr, view, member := e.emailOf(e.owner), e.emailOf(manager), e.emailOf(viewer), e.emailOf(e.member)

	started := time.Now().UTC().Truncate(time.Second)
	e.stopLapsed(started)
	acc := e.account()
	for range 3 {
		if err := e.in.Mail.StateChanged(ctx, acc); err != nil {
			t.Fatal(err)
		}
	}
	if n := e.notifications("lapsed:"); n != 1 {
		t.Fatalf("lapsed notifications %d, want 1 (deduplicated)", n)
	}
	for addr, want := range map[string]int{owner: 1, mgr: 1, view: 0, member: 0} {
		if got := e.mailsTo(mail.TemplateBillingLapsed, addr); got != want {
			t.Errorf("mails to %s: %d, want %d", addr, got, want)
		}
	}
	// The manager's mail is in Russian and names the blocker in Russian.
	var locale string
	if err := e.d.Pool.QueryRow(ctx, `SELECT locale FROM mail_outbox WHERE template = $1 AND to_addr = $2`, string(mail.TemplateBillingLapsed), mgr).Scan(&locale); err != nil || locale != "ru" {
		t.Fatalf("locale %q %v", locale, err)
	}
	if got := mail.FreeBlockers("ru", violations); got != "участники 12 / 10" {
		t.Fatal(got)
	}

	// A new episode (left the mode, entered again later) is a new mail.
	e.stopLapsed(started.Add(48 * time.Hour))
	acc = e.account()
	if err := e.in.Mail.StateChanged(ctx, acc); err != nil {
		t.Fatal(err)
	}
	if n := e.notifications("lapsed:"); n != 2 {
		t.Fatalf("second episode: %d notifications", n)
	}

	// Not stopped / not lapsed: nothing. Enforcement off (kill switch): nothing.
	e.in.Mail.Enforced = false
	e.stopLapsed(started.Add(96 * time.Hour))
	if err := e.in.Mail.StateChanged(ctx, e.account()); err != nil {
		t.Fatal(err)
	}
	if n := e.notifications("lapsed:"); n != 2 {
		t.Fatalf("enforcement off: %d notifications", n)
	}
}

// The heads-up a day before the last paid day ends is sent only when the workspace does not fit
// Free, once per end of the paid days, to the owner and the managers; the reconcile query finds
// the account only inside the last 24 hours.
func TestBillingLapseSoonMail(t *testing.T) {
	e := newEnv(t)
	fits := true
	e.in.Mail.Enforced = true
	e.in.Mail.FreeBlockers = func(context.Context, uuid.UUID) ([]*v1.PlanLimitViolation, error) {
		if fits {
			return nil, nil
		}
		return []*v1.PlanLimitViolation{{Kind: v1.PlanLimitKind_PLAN_LIMIT_KIND_STORAGE_MB, Current: 800, Limit: 500}}, nil
	}
	manager := e.holder(perm.BillingManage)
	owner, mgr := e.emailOf(e.owner), e.emailOf(manager)

	now := time.Now().UTC().Truncate(time.Second)
	set := func(due time.Time) {
		if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_accounts SET status = 'stopped', next_due_at = $2, lapsed_at = NULL WHERE id = $1`, e.acc, due); err != nil {
			t.Fatal(err)
		}
	}
	soon := func() int {
		rows, err := e.d.Q.ListBillingAccountsLapsingSoon(ctx, sqlc.ListBillingAccountsLapsingSoonParams{Now: now, Until: now.Add(24 * time.Hour), Lim: 100})
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		for _, r := range rows {
			if r.ID == e.acc {
				n++
			}
		}
		return n
	}

	set(now.Add(3 * 24 * time.Hour))
	if soon() != 0 {
		t.Fatal("three days left: not in the last 24 hours")
	}
	set(now.Add(10 * time.Hour))
	if soon() != 1 {
		t.Fatal("10 hours left: must be listed")
	}
	// Fits Free: nothing to warn about.
	if err := e.in.Mail.LapseSoon(ctx, e.account()); err != nil {
		t.Fatal(err)
	}
	if n := e.notifications("lapse_soon:"); n != 0 {
		t.Fatalf("fits Free: %d notifications", n)
	}
	// Does not fit: one mail each, however often the reconcile pass repeats.
	fits = false
	for range 3 {
		if err := e.in.Mail.LapseSoon(ctx, e.account()); err != nil {
			t.Fatal(err)
		}
	}
	if n := e.notifications("lapse_soon:"); n != 1 {
		t.Fatalf("%d notifications, want 1", n)
	}
	for _, addr := range []string{owner, mgr} {
		if got := e.mailsTo(mail.TemplateBillingLapseSoon, addr); got != 1 {
			t.Errorf("mails to %s: %d, want 1", addr, got)
		}
	}
	// Lapsed already (or active): not this mail.
	e.stopLapsed(now)
	if soon() != 0 {
		t.Fatal("a lapsed account is not 'lapsing soon'")
	}
	if err := e.in.Mail.LapseSoon(ctx, e.account()); err != nil {
		t.Fatal(err)
	}
	if n := e.notifications("lapse_soon:"); n != 1 {
		t.Fatalf("lapsed account: %d notifications", n)
	}
}
