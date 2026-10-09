//go:build integration

package core_test

import (
	"math/rand/v2"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// A late worker gives no free time: renewals start at the old boundaries, one per day missed.
func TestLateWorkerNoFreeTime(t *testing.T) {
	e := newEnv(t, 1)
	e.pay(100)
	e.activate(core.PlanTeam)
	e.tick(day(1).Add(5 * time.Hour))
	if c := e.lastCharge(); !c.StartsAt.Equal(day(1)) || !c.EndsAt.Equal(day(2)) {
		t.Fatalf("late renewal %+v", c)
	}
	e.tick(day(3).Add(5 * time.Hour)) // two boundaries missed
	cs := e.charges()
	if len(cs) != 4 || !cs[2].StartsAt.Equal(day(2)) || !cs[3].StartsAt.Equal(day(3)) {
		t.Fatalf("catch-up lots %+v", cs)
	}
	e.wantBalance(60)
	timeEq(t, "next_due", e.account().NextDueAt, day(4))

	// Admission catches up itself before deciding (the worker may be behind).
	e.at(day(5).Add(time.Hour))
	if _, err := e.join(); err != nil {
		t.Fatal(err)
	}
	// Renewals of the owner at days 4 and 5 (the new member is not counted before it joined) +
	// one day of the new member.
	e.wantBalance(60 - 10 - 10 - 10)
	if c := e.lastCharge(); c.Reason != core.ReasonAdmit || !c.StartsAt.Equal(day(5).Add(time.Hour)) {
		t.Fatalf("admit lot %+v", c)
	}
}

// A worker down past the deadline charges at most up to it and then suspends (not 10 days
// instead of 7).
func TestLongOutageStopsAtDeadline(t *testing.T) {
	e := newEnv(t, 1)
	e.pay(10)
	e.activate(core.PlanTeam)
	e.tick(day(30))
	a := e.account()
	if a.Status != core.StatusSuspended {
		t.Fatalf("status %s", a.Status)
	}
	e.wantBalance(-70) // days 1..7, deadline day 8
	if c := e.lastCharge(); !c.EndsAt.Equal(day(8)) {
		t.Fatalf("last lot %+v", c)
	}
}

// The same request twice charges once; the same payment twice credits once.
func TestIdempotency(t *testing.T) {
	e := newEnv(t, 1)
	p := e.pay(100)
	if _, err := e.c.CreditPaymentTx(ctx, p); err != nil {
		t.Fatal(err)
	}
	e.wantBalance(100)
	req := uuid.New()
	if _, err := e.c.Activate(ctx, e.acc, core.PlanTeam, req, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := e.c.Activate(ctx, e.acc, core.PlanTeam, req, nil); err != nil {
		t.Fatal(err)
	}
	e.wantBalance(90)
	u, join := e.user(), uuid.New()
	for range 2 {
		if err := e.joinUser(u, join); err != nil {
			t.Fatal(err)
		}
	}
	e.wantBalance(80)
	if n := len(e.charges()); n != 2 {
		t.Fatalf("%d charges", n)
	}
	credit := uuid.New()
	for range 2 {
		if _, err := e.c.AdminCredit(ctx, e.acc, 5, "x", credit, nil); err != nil {
			t.Fatal(err)
		}
	}
	e.wantBalance(85)
	_, err := e.c.AdminCredit(ctx, e.acc, 6, "x", credit, nil)
	wantErr(t, err, billing.ErrRequestReused)
	// Renewal of the same boundary twice (two workers): one lot.
	e.tick(day(1))
	e.tick(day(1))
	e.wantBalance(65)
}

// A failing command rolls back entirely: an upgrade without enough money keeps the old lots,
// compensations and plan.
func TestRollbackOfWholeCommand(t *testing.T) {
	e := newEnv(t, 10)
	e.pay(100)
	e.activate(core.PlanTeam)
	e.at(t0.Add(12 * time.Hour))
	n, before := e.ledgerCount(), e.charges()
	_, err := e.c.ChangePlan(ctx, e.acc, core.PlanEnterprise, uuid.New(), nil)
	wantErr(t, err, billing.ErrInsufficientFunds)
	if e.ledgerCount() != n || len(e.charges()) != len(before) || e.charges()[0].CanceledQty != 0 {
		t.Fatal("failed upgrade left changes")
	}
	if a := e.account(); a.Plan != core.PlanTeam {
		t.Fatalf("plan %s", a.Plan)
	}
	e.wantBalance(0)
}

// Plan change: downgrade compensates the rest of the current lots and buys a full new day;
// an upgrade with debt is refused.
func TestChangePlan(t *testing.T) {
	e := newEnv(t, 2)
	e.pay(60)
	e.activate(core.PlanEnterprise)
	if p := e.workspacePlan(); p.Plan != "enterprise" {
		t.Fatalf("plan %q", p.Plan)
	}
	e.at(t0.Add(12 * time.Hour))
	req := uuid.New()
	if _, err := e.c.ChangePlan(ctx, e.acc, core.PlanTeam, req, nil); err != nil {
		t.Fatal(err)
	}
	e.wantBalance(30 - 20) // 2 × 30 × 1/2 back, 2 × 10 bought
	if _, err := e.c.ChangePlan(ctx, e.acc, core.PlanTeam, req, nil); err != nil {
		t.Fatal(err)
	}
	e.wantBalance(10)
	a := e.account()
	if a.Plan != core.PlanTeam {
		t.Fatalf("plan %s", a.Plan)
	}
	timeEq(t, "next_due", a.NextDueAt, day(1).Add(12*time.Hour))
	if p := e.workspacePlan(); p.Plan != "team" || p.Source != "billing" {
		t.Fatalf("workspace plan %q", p.Plan)
	}
	// The old enterprise lot no longer covers anyone: a renewal at its end buys nothing extra.
	e.tick(day(1))
	e.wantBalance(10)
	// In debt: no upgrade.
	e.tick(day(1).Add(12 * time.Hour))
	e.wantBalance(-10)
	_, err := e.c.ChangePlan(ctx, e.acc, core.PlanEnterprise, uuid.New(), nil)
	wantErr(t, err, billing.ErrChangeIncompatible)
}

// Stop keeps the running lots; the plan turns Free when they end. Activate again later.
func TestStopAndReactivate(t *testing.T) {
	e := newEnv(t, 2)
	e.pay(100)
	e.activate(core.PlanTeam)
	e.at(t0.Add(time.Hour))
	if _, err := e.c.Stop(ctx, e.acc, nil); err != nil {
		t.Fatal(err)
	}
	a := e.account()
	if a.Status != core.StatusStopped {
		t.Fatalf("status %s", a.Status)
	}
	timeEq(t, "coverage end", a.NextDueAt, day(1))
	if p := e.workspacePlan(); p.Plan != "team" {
		t.Fatalf("plan during coverage %q", p.Plan)
	}
	e.tick(day(1))
	e.wantBalance(80)
	if p := e.workspacePlan(); p.Plan != "free" {
		t.Fatalf("plan after coverage %q", p.Plan)
	}
	if len(e.charges()) != 1 {
		t.Fatal("stopped account renewed")
	}
	e.tick(day(3))
	e.activate(core.PlanTeam)
	e.wantBalance(60)
	if p := e.workspacePlan(); p.Plan != "team" {
		t.Fatalf("plan after reactivation %q", p.Plan)
	}
}

// Two admissions racing for the last day of advance: exactly one member gets in.
func TestConcurrentAdmit(t *testing.T) {
	e := newEnv(t, 1)
	e.pay(20)
	e.activate(core.PlanTeam) // 10 left: one more seat-day
	users := []uuid.UUID{e.user(), e.user()}
	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make([]error, 2)
	for i := range 2 {
		wg.Go(func() {
			<-start
			errs[i] = e.d.Tx(ctx, func(q *sqlc.Queries) error {
				if _, err := q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: e.ws, UserID: users[i], Role: "member"}); err != nil {
					return err
				}
				return e.c.Admit(ctx, q, e.ws, users[i], uuid.New())
			})
		})
	}
	close(start)
	wg.Wait()
	ok := 0
	for i, err := range errs {
		if err == nil {
			ok++
			if !e.isMember(users[i]) {
				t.Fatal("admitted member missing")
			}
			continue
		}
		wantErr(t, err, billing.ErrSeatGrowthRequiresFunds)
		if e.isMember(users[i]) {
			t.Fatal("refused member kept")
		}
	}
	if ok != 1 {
		t.Fatalf("%d admissions succeeded: %v", ok, errs)
	}
	e.wantBalance(0)
}

// Refund reservation: unused money of the payment only, failure releases it, success records it.
func TestRefunds(t *testing.T) {
	e := newEnv(t, 1)
	p := e.pay(100)
	e.activate(core.PlanTeam)
	r, err := e.c.RefundableForPayment(ctx, e.d.Q, p)
	if err != nil || r.Minor != 90 {
		t.Fatalf("refundable %+v %v", r, err)
	}
	reserve := func(amount int64, key string) (sqlc.BillingRefund, error) {
		var ref sqlc.BillingRefund
		err := e.d.Tx(ctx, func(q *sqlc.Queries) error {
			var err error
			ref, _, err = e.c.ReserveRefund(ctx, q, core.RefundReq{PaymentID: p, Amount: amount, IdemKey: key, Origin: core.RefundOriginCalab})
			return err
		})
		return ref, err
	}
	apply := func(id uuid.UUID, status string) {
		t.Helper()
		if err := e.d.Tx(ctx, func(q *sqlc.Queries) error {
			_, _, err := e.c.ApplyRefundResult(ctx, q, id, status, ptr("re_"+uuid.NewString()))
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	_, err = reserve(91, "refund:a")
	wantErr(t, err, billing.ErrRefundExceedsRefundable)
	ref, err := reserve(50, "refund:b")
	if err != nil {
		t.Fatal(err)
	}
	e.wantBalance(40)
	if again, err := reserve(50, "refund:b"); err != nil || again.ID != ref.ID {
		t.Fatalf("replay %v", err)
	}
	e.wantBalance(40)
	apply(ref.ID, core.RefundFailed)
	e.wantBalance(90)
	apply(ref.ID, core.RefundSucceeded) // final already: no-op
	e.wantBalance(90)
	ref2, err := reserve(90, "refund:c")
	if err != nil {
		t.Fatal(err)
	}
	apply(ref2.ID, core.RefundSucceeded)
	e.wantBalance(0)
	pay, _ := e.d.Q.GetBillingPayment(ctx, p)
	if pay.RefundedMinor != 90 {
		t.Fatalf("payment refunded %d", pay.RefundedMinor)
	}
	// A refund made in the dashboard is recorded even when the money was spent already.
	e.at(t0.Add(time.Hour))
	if err := e.d.Tx(ctx, func(q *sqlc.Queries) error {
		_, _, err := e.c.ReserveRefund(ctx, q, core.RefundReq{PaymentID: p, Amount: 10, IdemKey: "dashboard:re_x",
			Origin: core.RefundOriginDashboard, Status: core.RefundSucceeded, ProviderRefundID: ptr("re_x")})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	e.wantBalance(-10)
	timeEq(t, "negative_since", e.account().NegativeSince, t0.Add(time.Hour))
}

// A dispute takes the money at once (spent part becomes debt), holds refunds; won → back.
func TestDispute(t *testing.T) {
	e := newEnv(t, 1)
	p := e.pay(100)
	e.activate(core.PlanTeam)
	e.at(t0.Add(time.Hour))
	tx := func(fn func(q *sqlc.Queries) error) {
		t.Helper()
		if err := e.d.Tx(ctx, fn); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		tx(func(q *sqlc.Queries) error {
			_, _, err := e.c.OpenDispute(ctx, q, core.DisputeReq{PaymentID: p, ProviderDisputeID: "dp_1", Amount: 100})
			return err
		})
	}
	e.wantBalance(-10)
	a := e.account()
	if !a.DisputeHold || a.NegativeSince == nil {
		t.Fatalf("dispute account %+v", a)
	}
	err := e.d.Tx(ctx, func(q *sqlc.Queries) error {
		_, _, err := e.c.ReserveRefund(ctx, q, core.RefundReq{PaymentID: p, Amount: 1, IdemKey: "refund:d", Origin: core.RefundOriginCalab})
		return err
	})
	wantErr(t, err, billing.ErrDisputeHold)
	for range 2 {
		tx(func(q *sqlc.Queries) error {
			_, _, err := e.c.CloseDispute(ctx, q, "dp_1", core.DisputeWon)
			return err
		})
	}
	e.wantBalance(90)
	if a := e.account(); a.DisputeHold || a.NegativeSince != nil {
		t.Fatalf("after won %+v", a)
	}
}

// Kill switches and the incident hold: no debits, no suspension.
func TestSwitchesAndHold(t *testing.T) {
	e := newEnv(t, 1)
	e.pay(10)
	e.activate(core.PlanTeam)
	off := core.New(e.d, e.clk, core.Config{}, core.Hooks{})
	e.at(day(2))
	if err := e.d.Tx(ctx, func(q *sqlc.Queries) error {
		u := e.user()
		if _, err := q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: e.ws, UserID: u, Role: "member"}); err != nil {
			return err
		}
		return off.Admit(ctx, q, e.ws, u, uuid.New())
	}); err != nil {
		t.Fatal(err)
	}
	_, err := off.ChangePlan(ctx, e.acc, core.PlanEnterprise, uuid.New(), nil)
	wantErr(t, err, billing.ErrDisabled)
	e.wantBalance(0)
	hold := day(20)
	if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_accounts SET hold_until = $2 WHERE id = $1`, e.acc, hold); err != nil {
		t.Fatal(err)
	}
	e.tick(day(19))
	if len(e.charges()) != 1 || e.account().Status != core.StatusActive {
		t.Fatal("held account was charged or suspended")
	}
	e.tick(day(21)) // hold over: catch-up from day 1, suspended at the deadline
	if a := e.account(); a.Status != core.StatusSuspended {
		t.Fatalf("after hold %s", a.Status)
	}
	e.wantBalance(-140) // 2 seats × days 1..7
}

// Property: after any random sequence of operations the ledger, the lots and the charges agree
// (sum(ledger) = balance = free advance - debt, never both), and every refusal is an API error.
func TestRandomOperationsKeepInvariants(t *testing.T) {
	for seed := range uint64(4) {
		r := rand.New(rand.NewPCG(seed, 99)) //nolint:gosec // deterministic test sequence
		e := newEnv(t, 1+r.IntN(4))
		e.pay(int64(10 * (1 + r.IntN(10))))
		var payments, credits []uuid.UUID
		for step := range 120 {
			var err error
			switch op := r.IntN(13); op {
			case 0:
				payments = append(payments, e.pay(int64(1+r.IntN(80))))
			case 1:
				credits = append(credits, e.credit(int64(1+r.IntN(30))))
			case 2:
				_, err = e.join()
			case 3:
				if len(e.members) > 0 {
					e.remove(1)
				}
			case 4, 5:
				e.tick(e.clk.Time().Add(time.Duration(1+r.IntN(30)) * time.Hour))
			case 6:
				_, err = e.c.Activate(ctx, e.acc, []string{core.PlanTeam, core.PlanEnterprise}[r.IntN(2)], uuid.New(), nil)
			case 7:
				_, err = e.c.ChangePlan(ctx, e.acc, []string{core.PlanTeam, core.PlanEnterprise}[r.IntN(2)], uuid.New(), nil)
			case 8:
				_, err = e.c.CancelSeats(ctx, e.acc, []int32{1, 2}[r.IntN(2)], uuid.New(), nil)
			case 9:
				if r.IntN(3) == 0 {
					_, err = e.c.Stop(ctx, e.acc, nil)
				} else {
					_, err = e.c.Resume(ctx, e.acc, []string{core.ResumeFree, core.ResumePaid}[r.IntN(2)], core.PlanTeam, uuid.New(), nil)
				}
			case 10:
				if len(credits) > 0 {
					_, err = e.c.ReverseAdminCredit(ctx, credits[r.IntN(len(credits))], "x", nil)
				}
			case 11:
				if len(payments) > 0 {
					p := payments[r.IntN(len(payments))]
					err = e.d.Tx(ctx, func(q *sqlc.Queries) error {
						ref, _, err := e.c.ReserveRefund(ctx, q, core.RefundReq{PaymentID: p, Amount: int64(1 + r.IntN(20)),
							IdemKey: "refund:" + uuid.NewString(), Origin: core.RefundOriginCalab})
						if err != nil {
							return err
						}
						_, _, err = e.c.ApplyRefundResult(ctx, q, ref.ID, []string{core.RefundSucceeded, core.RefundFailed}[r.IntN(2)], nil)
						return err
					})
				}
			case 12:
				if len(payments) > 0 {
					p := payments[r.IntN(len(payments))]
					id := "dp_" + uuid.NewString()
					err = e.d.Tx(ctx, func(q *sqlc.Queries) error {
						if _, _, err := e.c.OpenDispute(ctx, q, core.DisputeReq{PaymentID: p, ProviderDisputeID: id, Amount: int64(1 + r.IntN(50))}); err != nil {
							return err
						}
						_, _, err := e.c.CloseDispute(ctx, q, id, []string{core.DisputeWon, core.DisputeLost}[r.IntN(2)])
						return err
					})
				}
			}
			if !apiErr(err) {
				t.Fatalf("seed %d step %d: %v", seed, step, err)
			}
			e.check()
		}
	}
}

// The nightly check reports a balance cache that disagrees with the ledger and the lots.
func TestIntegrityDetectsMismatch(t *testing.T) {
	e := newEnv(t, 1)
	e.pay(30)
	e.check()
	if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_accounts SET balance_minor = balance_minor + 1 WHERE id = $1`, e.acc); err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, m := range e.w.CheckIntegrity(ctx) {
		if m.AccountID == e.acc {
			found[m.Check] = true
		}
	}
	if !found[core.CheckLedger] || !found[core.CheckFunding] {
		t.Fatalf("mismatch not reported: %v", found)
	}
	if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_accounts SET balance_minor = balance_minor - 1 WHERE id = $1`, e.acc); err != nil {
		t.Fatal(err)
	}
	e.check()
}
