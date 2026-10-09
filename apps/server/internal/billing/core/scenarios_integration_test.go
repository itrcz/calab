//go:build integration

package core_test

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Money scenarios M1–M23 of docs/plans/balance-billing-v1.md (USD cents unless noted), on the
// fake clock from t0. Every step ends with the account invariants (env.check).

// M1–M4: activation, growth, replacement inside the covered capacity, partial renewal.
func TestM1toM4SeatLifecycle(t *testing.T) {
	e := newEnv(t, 10)
	e.pay(1000)
	e.activate(core.PlanTeam)
	// M1: Team, balance 1000, 10 people → debit 100, balance 900, 24 h.
	e.wantBalance(900)
	c := e.lastCharge()
	if c.Qty != 10 || c.AmountMinor != 100 || !c.StartsAt.Equal(t0) || !c.EndsAt.Equal(day(1)) || c.Reason != core.ReasonActivate {
		t.Fatalf("M1 lot %+v", c)
	}
	acc := e.account()
	timeEq(t, "next_due", acc.NextDueAt, day(1))
	if p := e.workspacePlan(); p.Plan != "team" || p.Source != "billing" {
		t.Fatalf("plan %q source %q", p.Plan, p.Source)
	}

	// M2: two more 6 h later → debit 20, balance 880, their expiry 6 h later.
	e.at(t0.Add(6 * time.Hour))
	for range 2 {
		if _, err := e.join(); err != nil {
			t.Fatal(err)
		}
	}
	e.wantBalance(880)
	c = e.lastCharge()
	if c.Qty != 1 || c.AmountMinor != 10 || !c.EndsAt.Equal(day(1).Add(6*time.Hour)) || c.Reason != core.ReasonAdmit {
		t.Fatalf("M2 lot %+v", c)
	}

	// M3: remove one and take a replacement inside the covered capacity → no debit.
	e.at(t0.Add(7 * time.Hour))
	e.remove(1)
	e.at(t0.Add(8 * time.Hour))
	n := len(e.charges())
	if _, err := e.join(); err != nil {
		t.Fatal(err)
	}
	if len(e.charges()) != n {
		t.Fatal("M3: replacement was charged")
	}
	e.wantBalance(880)

	// M4: 10 people left, 2 seats live past the first boundary → renewal 8, debit 80.
	e.remove(2)
	e.tick(day(1))
	e.wantBalance(800)
	c = e.lastCharge()
	if c.Qty != 8 || c.AmountMinor != 80 || !c.StartsAt.Equal(day(1)) || c.Reason != core.ReasonRenew {
		t.Fatalf("M4 lot %+v", c)
	}
	timeEq(t, "next_due", e.account().NextDueAt, day(1).Add(6*time.Hour))
	// The longer seats end 6 h later: 2 renewed then.
	e.tick(day(1).Add(6 * time.Hour))
	e.wantBalance(780)
	if c = e.lastCharge(); c.Qty != 2 || !c.EndsAt.Equal(day(2).Add(6*time.Hour)) {
		t.Fatalf("M4 second boundary %+v", c)
	}
}

// M5: 1 Team, balance 10, activate → balance 0, a full paid day.
func TestM5ExactFirstDay(t *testing.T) {
	e := newEnv(t, 1)
	e.pay(10)
	e.activate(core.PlanTeam)
	e.wantBalance(0)
	c := e.lastCharge()
	if c.AmountMinor != 10 || c.UnfundedMinor != 0 || !c.EndsAt.Equal(day(1)) {
		t.Fatalf("M5 %+v", c)
	}
	if a := e.account(); a.NegativeSince != nil || a.Status != core.StatusActive {
		t.Fatalf("M5 account %+v", a)
	}
	// Activation never goes into debt.
	e2 := newEnv(t, 2)
	e2.pay(19)
	_, err := e2.c.Activate(ctx, e2.acc, core.PlanTeam, uuid.New(), nil)
	wantErr(t, err, billing.ErrInsufficientFunds)
	e2.wantBalance(19)
	if e2.account().Status != core.StatusInactive || len(e2.charges()) != 0 {
		t.Fatal("refused activation changed the account")
	}
}

// M6: renewal of 10 Team with balance 1 → debit 100, balance -99, episode, deadline +7 d.
func TestM6RenewalIntoDebt(t *testing.T) {
	e := newEnv(t, 10)
	e.pay(101)
	e.activate(core.PlanTeam)
	e.tick(day(1))
	e.wantBalance(-99)
	a := e.account()
	timeEq(t, "negative_since", a.NegativeSince, day(1))
	timeEq(t, "suspend_at", a.SuspendAt, day(8))
	if c := e.lastCharge(); c.AmountMinor != 100 || c.UnfundedMinor != 99 {
		t.Fatalf("M6 lot %+v", c)
	}
	// The next renewal keeps the episode where it started.
	e.tick(day(2))
	e.wantBalance(-199)
	a = e.account()
	timeEq(t, "negative_since", a.NegativeSince, day(1))
	timeEq(t, "suspend_at", a.SuspendAt, day(8))
}

// M7: 5 Business → daily 150, reserve30d 4500 ($45).
func TestM7BusinessQuote(t *testing.T) {
	e := newEnv(t, 5)
	q, err := e.c.Quote(ctx, e.acc, core.PlanEnterprise)
	if err != nil {
		t.Fatal(err)
	}
	if q.DailyMinor != 150 || q.Reserve30dMinor != 4500 || q.FirstDayMinor != 150 || q.Billable != 5 || q.Currency != "USD" {
		t.Fatalf("M7 %+v", q)
	}
}

// M8 / M9: a 10 % discount gives unit 9 (3 seats = 27); a top-up of 1000 credits 1000; when the
// discount ends the bought lots stay as they are; a new price version applies from its
// effective_from on.
func TestM8M9DiscountAndPriceVersions(t *testing.T) {
	e := newEnv(t, 3)
	base := day(400) // far from the other scenarios: the price row below is shared
	e.at(base)
	if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_accounts SET discount_bps = 1000 WHERE id = $1`, e.acc); err != nil {
		t.Fatal(err)
	}
	e.pay(1000)
	e.wantBalance(1000)
	e.activate(core.PlanTeam)
	e.wantBalance(973)
	first := e.lastCharge()
	if first.UnitMinor != 9 || first.AmountMinor != 27 || first.DiscountBps != 1000 {
		t.Fatalf("M8 %+v", first)
	}
	// M9: the discount ends; the bought lot keeps unit 9, the next day costs 10.
	if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_accounts SET discount_bps = 0 WHERE id = $1`, e.acc); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Q.InsertBillingPrice(ctx, sqlc.InsertBillingPriceParams{Market: "global", Currency: "USD", Sku: "seat.team.day",
		Plan: ptr("team"), UnitMinor: 12, EffectiveFrom: base.Add(2 * billing.Day)}); err != nil {
		t.Fatal(err)
	}
	e.tick(base.Add(billing.Day))
	e.wantBalance(943)
	if again := e.charges()[0]; again.UnitMinor != 9 || again.AmountMinor != 27 {
		t.Fatalf("M9 old lot changed %+v", again)
	}
	if c := e.lastCharge(); c.UnitMinor != 10 || c.AmountMinor != 30 {
		t.Fatalf("M9 renewal %+v", c)
	}
	e.tick(base.Add(2 * billing.Day))
	e.wantBalance(907)
	if c := e.lastCharge(); c.UnitMinor != 12 || c.AmountMinor != 36 {
		t.Fatalf("new price version %+v", c)
	}
}

func ptr[T any](v T) *T { return &v }

// M10: giving back 2 fully paid Team seats for half a day → compensation 10, once.
func TestM10CancelSeats(t *testing.T) {
	e := newEnv(t, 10)
	e.pay(1000)
	e.activate(core.PlanTeam)
	e.remove(2)
	e.at(t0.Add(12 * time.Hour))
	req := uuid.New()
	got, err := e.c.CancelSeats(ctx, e.acc, 2, req, &e.owner)
	if err != nil || got != 10 {
		t.Fatalf("M10 compensation %d %v", got, err)
	}
	e.wantBalance(910)
	if c := e.charges()[0]; c.CanceledQty != 2 || c.CompensatedMinor != 10 {
		t.Fatalf("M10 lot %+v", c)
	}
	// Replay: nothing again.
	if got, err := e.c.CancelSeats(ctx, e.acc, 2, req, &e.owner); err != nil || got != 0 {
		t.Fatalf("M10 replay %d %v", got, err)
	}
	e.wantBalance(910)
	// The capacity is gone: a new member needs a new seat.
	if _, err := e.join(); err != nil {
		t.Fatal(err)
	}
	e.wantBalance(900)
	// The current team keeps its seats.
	_, err = e.c.CancelSeats(ctx, e.acc, 1, uuid.New(), &e.owner)
	wantErr(t, err, billing.ErrChangeIncompatible)
}

// M11: 10 Team with debt 200 → auto-topup A = 200 + 3000 = 3200 ($32).
func TestM11AutoTopupAmount(t *testing.T) {
	e := newEnv(t, 10)
	e.pay(100)
	e.activate(core.PlanTeam)
	e.tick(day(1))
	e.tick(day(2))
	e.wantBalance(-200)
	q, err := e.c.Quote(ctx, e.acc, "")
	if err != nil {
		t.Fatal(err)
	}
	if q.DebtMinor != 200 || q.Reserve30dMinor != 3000 || q.AutoTopupMinor != 3200 || q.Covered != 10 {
		t.Fatalf("M11 %+v", q)
	}
}

// M12: funding 1000 + 2000, debit 1200 → FIFO 1000 + 200, 1800 left.
func TestM12FIFO(t *testing.T) {
	e := newEnv(t, 40)
	p1, p2 := e.pay(1000), e.pay(2000)
	e.activate(core.PlanEnterprise)
	e.wantBalance(1800)
	if l1, l2 := e.lotOf(p1), e.lotOf(p2); l1.ConsumedMinor != 1000 || l2.ConsumedMinor != 200 {
		t.Fatalf("M12 lots %d %d", l1.ConsumedMinor, l2.ConsumedMinor)
	}
}

// M13: RUB (secondary market): 10 Team / Business daily 6000 / 18000 kopecks, reserve
// 180000 / 540000, no FX.
func TestM13RUB(t *testing.T) {
	e := newEnvMarket(t, 10, "ru")
	for plan, want := range map[string][2]int64{core.PlanTeam: {6000, 180000}, core.PlanEnterprise: {18000, 540000}} {
		q, err := e.c.Quote(ctx, e.acc, plan)
		if err != nil {
			t.Fatal(err)
		}
		if q.Currency != "RUB" || q.DailyMinor != want[0] || q.Reserve30dMinor != want[1] {
			t.Fatalf("M13 %s %+v", plan, q)
		}
	}
	e.pay(6000)
	e.activate(core.PlanTeam)
	e.wantBalance(0)
}

// debt1000 is the base of M14 / M15 / M17 / M21: 100 Team members, balance 0 after the first
// day, the renewal at day 1 leaves -1000 (episode from day 1, deadline day 8).
func debt1000(t *testing.T) *env {
	e := newEnv(t, 100)
	e.pay(1000)
	e.activate(core.PlanTeam)
	e.tick(day(1))
	e.wantBalance(-1000)
	return e
}

// M14: debt 1000, top-up 400 → balance -600, the original deadline.
func TestM14PartialPayment(t *testing.T) {
	e := debt1000(t)
	e.at(day(1).Add(time.Hour))
	e.pay(400)
	e.wantBalance(-600)
	a := e.account()
	timeEq(t, "negative_since", a.NegativeSince, day(1))
	timeEq(t, "suspend_at", a.SuspendAt, day(8))
	if c := e.lastCharge(); c.UnfundedMinor != 600 {
		t.Fatalf("M14 debt on the charge %d", c.UnfundedMinor)
	}
}

// M15: debt 1000, top-up 1100 → 1000 to the old charge, 100 advance, episode closed after the
// due catch-up.
func TestM15Overpayment(t *testing.T) {
	e := debt1000(t)
	e.at(day(1).Add(time.Hour))
	p := e.pay(1100)
	e.wantBalance(100)
	if c := e.lastCharge(); c.UnfundedMinor != 0 {
		t.Fatalf("M15 charge still unpaid %d", c.UnfundedMinor)
	}
	if l := e.lotOf(p); l.ConsumedMinor != 1000 {
		t.Fatalf("M15 lot consumed %d", l.ConsumedMinor)
	}
	if a := e.account(); a.NegativeSince != nil || a.SuspendAt != nil {
		t.Fatalf("M15 episode open %+v", a)
	}
	// A payment that lands after a due renewal pays the debt left after it.
	e2 := debt1000(t)
	e2.at(day(2).Add(time.Hour)) // the day 2 renewal (-1000) is due but not applied yet
	e2.pay(1500)
	e2.wantBalance(-500)
	timeEq(t, "suspend_at", e2.account().SuspendAt, day(8))
}

// M16: balance -1 at the deadline → full suspension, no new intervals afterwards.
func TestM16SuspensionAtDeadline(t *testing.T) {
	e := newEnv(t, 1)
	e.pay(10)
	e.activate(core.PlanTeam)
	for d := 1; d <= 7; d++ {
		e.tick(day(d))
	}
	e.wantBalance(-70)
	e.at(day(7).Add(time.Hour))
	e.pay(69)
	e.wantBalance(-1)
	n := len(e.charges())
	e.tick(day(8))
	a := e.account()
	if a.Status != core.StatusSuspended || a.NextDueAt != nil {
		t.Fatalf("M16 not suspended %+v", a)
	}
	e.wantBalance(-1)
	for d := 9; d <= 40; d += 7 {
		e.tick(day(d))
	}
	if len(e.charges()) != n || e.balance() != -1 {
		t.Fatal("M16 charged a suspended account")
	}
	_, err := e.join()
	wantErr(t, err, billing.ErrWorkspaceBillingSuspended)
	_, err = e.c.ChangePlan(ctx, e.acc, core.PlanEnterprise, uuid.New(), nil)
	wantErr(t, err, billing.ErrWorkspaceBillingSuspended)
	if p := e.workspacePlan(); p.Plan != "team" {
		t.Fatalf("suspension changed the plan to %q", p.Plan)
	}
}

// M17: debt 1000, resume_paid for 10 Team → quote 1100 = debt 1000 + first day 100.
func TestM17ResumePaid(t *testing.T) {
	e := debt1000(t)
	if _, err := e.c.Stop(ctx, e.acc, &e.owner); err != nil {
		t.Fatal(err)
	}
	e.remove(90)
	e.tick(day(2)) // coverage of the stopped plan ends
	if p := e.workspacePlan(); p.Plan != "free" {
		t.Fatalf("coverage end plan %q", p.Plan)
	}
	e.tick(day(8))
	if e.account().Status != core.StatusSuspended {
		t.Fatal("stopped account in debt not suspended")
	}
	e.wantBalance(-1000)
	q, err := e.c.Quote(ctx, e.acc, core.PlanTeam)
	if err != nil {
		t.Fatal(err)
	}
	if q.ResumePaidMinor != 1100 || q.DebtMinor != 1000 || q.FirstDayMinor != 100 {
		t.Fatalf("M17 quote %+v", q)
	}
	e.at(day(9))
	e.pay(1000)
	_, err = e.c.Resume(ctx, e.acc, core.ResumePaid, core.PlanTeam, uuid.New(), &e.owner)
	wantErr(t, err, billing.ErrInsufficientFunds)
	e.pay(100)
	if _, err := e.c.Resume(ctx, e.acc, core.ResumePaid, core.PlanTeam, uuid.New(), &e.owner); err != nil {
		t.Fatal(err)
	}
	e.wantBalance(0)
	a := e.account()
	if a.Status != core.StatusActive || a.NegativeSince != nil {
		t.Fatalf("M17 account %+v", a)
	}
	if c := e.lastCharge(); c.Qty != 10 || !c.StartsAt.Equal(day(9)) || c.Reason != core.ReasonResume {
		t.Fatalf("M17 lot %+v", c)
	}
	if p := e.workspacePlan(); p.Plan != "team" {
		t.Fatalf("resume plan %q", p.Plan)
	}
}

// M18: 1 Team, 6 h before the deadline → the last lot is cut there: 10 × 6/24 = 2.5 → 3.
func TestM18ProratedLastDay(t *testing.T) {
	e := newEnv(t, 1)
	lot := e.credit(10)
	e.activate(core.PlanTeam)
	e.at(t0.Add(6 * time.Hour))
	// A reversed credit takes the money of the first day back: debt from t0+6h.
	if taken, err := e.c.ReverseAdminCredit(ctx, lot, "wrong credit", &e.owner); err != nil || taken != 10 {
		t.Fatalf("reverse %d %v", taken, err)
	}
	e.wantBalance(-10)
	timeEq(t, "suspend_at", e.account().SuspendAt, day(7).Add(6*time.Hour))
	for d := 1; d <= 8; d++ {
		e.tick(day(d))
	}
	cs := e.charges()
	last := cs[len(cs)-1]
	if last.AmountMinor != 3 || !last.StartsAt.Equal(day(7)) || !last.EndsAt.Equal(day(7).Add(6*time.Hour)) {
		t.Fatalf("M18 last lot %+v", last)
	}
	if len(cs) != 8 { // activation + 6 full days + the cut one
		t.Fatalf("M18 %d lots", len(cs))
	}
	e.wantBalance(-10 - 60 - 3)
	if e.account().Status != core.StatusSuspended {
		t.Fatal("M18 not suspended at the deadline")
	}
	_, err := e.c.ReverseAdminCredit(ctx, lot, "again", &e.owner)
	wantErr(t, err, core.ErrCreditAlreadyReversed)
}

// M19: giving back part of a lot that is entirely debt → the receivable shrinks, cash 0.
func TestM19CancelDebtLot(t *testing.T) {
	e := newEnv(t, 10)
	p := e.pay(100)
	e.activate(core.PlanTeam)
	e.tick(day(1))
	e.wantBalance(-100)
	e.remove(5)
	e.at(day(1).Add(12 * time.Hour))
	got, err := e.c.CancelSeats(ctx, e.acc, 5, uuid.New(), &e.owner)
	if err != nil || got != 25 {
		t.Fatalf("M19 compensation %d %v", got, err)
	}
	e.wantBalance(-75)
	if c := e.lastCharge(); c.UnfundedMinor != 75 {
		t.Fatalf("M19 debt %d", c.UnfundedMinor)
	}
	r, err := e.c.RefundableForPayment(ctx, e.d.Q, p)
	if err != nil || r.Minor != 0 {
		t.Fatalf("M19 refundable %+v %v", r, err)
	}
}

// m20 builds a renewal of seats × 10 cents funded 5/10 cash + 3/10 admin + 2/10 debt and stops
// the plan (so its seats may be given back).
func m20(t *testing.T, seats int) (e *env, cash uuid.UUID, admin uuid.UUID) {
	e = newEnv(t, seats)
	e.pay(int64(10 * seats))
	e.activate(core.PlanTeam)
	e.at(t0.Add(time.Hour))
	cash = e.pay(int64(5 * seats))
	admin = e.credit(int64(3 * seats))
	e.tick(day(1))
	e.wantBalance(int64(-2 * seats))
	if _, err := e.c.Stop(ctx, e.acc, &e.owner); err != nil {
		t.Fatal(err)
	}
	e.at(day(1).Add(12 * time.Hour))
	return e, cash, admin
}

// M20: charge 10 = 5 cash + 3 admin + 2 debt, give back 5 → 2 debt + 3 admin cancelled, cash
// refund 0; several partial returns give the same result as one.
func TestM20MixedCompensation(t *testing.T) {
	e, cash, admin := m20(t, 1)
	got, err := e.c.CancelSeats(ctx, e.acc, 1, uuid.New(), &e.owner)
	if err != nil || got != 5 {
		t.Fatalf("M20 compensation %d %v", got, err)
	}
	e.wantBalance(3)
	if c := e.lastCharge(); c.UnfundedMinor != 0 || c.CompensatedMinor != 5 {
		t.Fatalf("M20 charge %+v", c)
	}
	if l := e.lotOf(cash); l.ConsumedMinor != 5 {
		t.Fatalf("M20 cash lot consumed %d", l.ConsumedMinor)
	}
	if l := e.lot(admin); l.AmountMinor-l.ConsumedMinor-l.RefundedMinor != 3 {
		t.Fatalf("M20 admin lot %+v", l)
	}
	if r, _ := e.c.RefundableForPayment(ctx, e.d.Q, cash); r.Minor != 0 {
		t.Fatalf("M20 cash refundable %d", r.Minor)
	}

	// Two seats returned at once vs one by one: the same money in the same places.
	a, cashA, adminA := m20(t, 2)
	b, cashB, adminB := m20(t, 2)
	if got, err := a.c.CancelSeats(ctx, a.acc, 2, uuid.New(), nil); err != nil || got != 10 {
		t.Fatalf("all at once %d %v", got, err)
	}
	var sum int64
	for range 2 {
		got, err := b.c.CancelSeats(ctx, b.acc, 1, uuid.New(), nil)
		if err != nil {
			t.Fatal(err)
		}
		sum += got
	}
	if sum != 10 || a.balance() != b.balance() || a.balance() != 6 {
		t.Fatalf("split %d, balances %d %d", sum, a.balance(), b.balance())
	}
	if a.lotOf(cashA).ConsumedMinor != b.lotOf(cashB).ConsumedMinor || a.lot(adminA).ConsumedMinor != b.lot(adminB).ConsumedMinor {
		t.Fatal("split returns moved money differently")
	}
	a.check()
	b.check()
}

// M21: stop, debt 1000, pay 1000, resume_free → Free without buying Team / Business.
func TestM21ResumeFree(t *testing.T) {
	e := debt1000(t)
	if _, err := e.c.Stop(ctx, e.acc, &e.owner); err != nil {
		t.Fatal(err)
	}
	e.tick(day(8))
	if e.account().Status != core.StatusSuspended {
		t.Fatal("not suspended")
	}
	_, err := e.c.Resume(ctx, e.acc, core.ResumeFree, "", uuid.New(), &e.owner)
	wantErr(t, err, billing.ErrInsufficientFunds)
	e.at(day(8).Add(time.Hour))
	e.pay(1000)
	n := len(e.charges())
	if _, err := e.c.Resume(ctx, e.acc, core.ResumeFree, "", uuid.New(), &e.owner); err != nil {
		t.Fatal(err)
	}
	e.wantBalance(0)
	a := e.account()
	if a.Status != core.StatusStopped || a.NegativeSince != nil || a.NextDueAt != nil || len(e.charges()) != n {
		t.Fatalf("M21 %+v", a)
	}
	if p := e.workspacePlan(); p.Plan != "free" || p.Source != "billing" {
		t.Fatalf("M21 plan %q %q", p.Plan, p.Source)
	}
	// Joining a Free (stopped) workspace costs nothing.
	if _, err := e.join(); err != nil {
		t.Fatal(err)
	}
	e.wantBalance(0)
}

// M22: 1 Team paid, balance 0, joins → 409, neither membership nor debit.
func TestM22NoGrowthIntoDebt(t *testing.T) {
	e := newEnv(t, 1)
	e.pay(10)
	e.activate(core.PlanTeam)
	n := e.ledgerCount()
	for range 3 {
		u, err := e.join()
		wantErr(t, err, billing.ErrSeatGrowthRequiresFunds)
		if e.isMember(u) {
			t.Fatal("M22 membership kept")
		}
	}
	if e.ledgerCount() != n {
		t.Fatal("M22 ledger changed")
	}
	e.wantBalance(0)
}

// M23: in debt with one free covered seat → the replacement is free; a seat beyond the
// capacity is refused.
func TestM23ReplacementInDebt(t *testing.T) {
	e := newEnv(t, 2)
	e.pay(20)
	e.activate(core.PlanTeam)
	e.tick(day(1))
	e.wantBalance(-20)
	e.remove(1)
	if _, err := e.join(); err != nil {
		t.Fatal(err)
	}
	e.wantBalance(-20)
	_, err := e.join()
	wantErr(t, err, billing.ErrSeatGrowthRequiresFunds)
	e.wantBalance(-20)
}
