package core

import (
	"math/rand/v2"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

func TestChargeAmount(t *testing.T) {
	for _, tc := range []struct {
		name string
		unit int64
		qty  int32
		d    time.Duration
		want int64
	}{
		{"M1 10 Team full day", 10, 10, billing.Day, 100},
		{"M7 5 Business", 30, 5, billing.Day, 150},
		{"M8 discount unit 9 × 3", 9, 3, billing.Day, 27},
		{"M13 RUB 10 Team", 600, 10, billing.Day, 6000},
		{"M18 6h before deadline: 2.5 → 3 half up", 10, 1, 6 * time.Hour, 3},
		{"18h: 7.5 → 8", 10, 1, 18 * time.Hour, 8},
		{"1h: 0.41 → 0", 10, 1, time.Hour, 0},
		{"one second of 2 seats", 10, 2, time.Second, 0},
	} {
		got, err := ChargeAmount(tc.unit, tc.qty, tc.d)
		if err != nil || got != tc.want {
			t.Errorf("%s: %d, %v; want %d", tc.name, got, err, tc.want)
		}
	}
}

func TestCompensationTargetCumulative(t *testing.T) {
	// M10: 2 of 10 fully paid Team seats given back for half a day = 10 cents.
	got, err := CompensationTarget(100, 10, billing.Day, 2*(12*time.Hour).Microseconds())
	if err != nil || got != 10 {
		t.Fatalf("M10: %d %v", got, err)
	}
	// Partial cancellations sum to the same as one: 3 seats of a 7-cent lot returned one by one.
	whole := (24 * time.Hour).Microseconds()
	step := (5 * time.Hour).Microseconds()
	var cum, sum int64
	for range 3 {
		cum += step
		target, err := CompensationTarget(7, 3, billing.Day, cum)
		if err != nil {
			t.Fatal(err)
		}
		sum = target
	}
	once, _ := CompensationTarget(7, 3, billing.Day, 3*step)
	if sum != once {
		t.Fatalf("cumulative %d != one %d", sum, once)
	}
	if all, _ := CompensationTarget(7, 3, billing.Day, 3*whole+5); all != 7 {
		t.Fatalf("never more than the lot: %d", all)
	}
}

func TestAllocateFIFO(t *testing.T) {
	// M12: lots 1000 + 2000, debit 1200 → 1000 + 200, 1800 left.
	parts, rest := allocate([]int64{1000, 2000}, 1200)
	if rest != 0 || len(parts) != 2 || parts[0] != (part{0, 1000}) || parts[1] != (part{1, 200}) {
		t.Fatalf("M12: %v rest %d", parts, rest)
	}
	parts, rest = allocate([]int64{0, 5, 3}, 10)
	if rest != 2 || len(parts) != 2 || parts[0] != (part{1, 5}) || parts[1] != (part{2, 3}) {
		t.Fatalf("debt rest: %v %d", parts, rest)
	}
	if parts, rest = allocate(nil, 7); len(parts) != 0 || rest != 7 {
		t.Fatalf("no lots: %v %d", parts, rest)
	}
}

func TestComputeQuote(t *testing.T) {
	for _, tc := range []struct {
		name                         string
		in                           QuoteInput
		daily, reserve, auto, resume int64
		daysLeft                     int64
	}{
		{"M7 5 Business", QuoteInput{Billable: 5, UnitMinor: 30}, 150, 4500, 4500, 150, 0},
		{"M11 10 Team, debt 200", QuoteInput{Billable: 10, Covered: 10, UnitMinor: 10, BalanceMinor: -200}, 100, 3000, 3200, 200, 0},
		{"M13 RUB 10 Team", QuoteInput{Billable: 10, UnitMinor: 600}, 6000, 180000, 180000, 6000, 0},
		{"M13 RUB 10 Business", QuoteInput{Billable: 10, UnitMinor: 1800}, 18000, 540000, 540000, 18000, 0},
		{"M17 debt 1000, resume paid 10 Team", QuoteInput{Billable: 10, UnitMinor: 10, BalanceMinor: -1000}, 100, 3000, 4000, 1100, 0},
		{"days left", QuoteInput{Billable: 10, Covered: 10, UnitMinor: 10, BalanceMinor: 950}, 100, 3000, 3000, 0, 9},
	} {
		q, err := ComputeQuote(tc.in)
		if err != nil {
			t.Fatal(err)
		}
		if q.DailyMinor != tc.daily || q.Reserve30dMinor != tc.reserve || q.AutoTopupMinor != tc.auto ||
			q.ResumePaidMinor != tc.resume || q.DaysLeft != tc.daysLeft {
			t.Errorf("%s: %+v", tc.name, q)
		}
	}
}

func TestPlanFor(t *testing.T) {
	due := time.Now()
	for _, tc := range []struct {
		acc     sqlc.BillingAccount
		plan    string
		managed bool
	}{
		{sqlc.BillingAccount{Status: StatusInactive, Plan: PlanTeam}, "", false},
		{sqlc.BillingAccount{Status: StatusActive, Plan: PlanEnterprise}, PlanEnterprise, true},
		{sqlc.BillingAccount{Status: StatusSuspended, Plan: PlanTeam}, PlanTeam, true},
		{sqlc.BillingAccount{Status: StatusStopped, Plan: PlanTeam, NextDueAt: &due}, PlanTeam, true},
		{sqlc.BillingAccount{Status: StatusStopped, Plan: PlanTeam}, PlanFree, true},
		{sqlc.BillingAccount{Status: StatusClosed, Plan: PlanTeam}, "", false},
	} {
		if p, m := PlanFor(tc.acc); p != tc.plan || m != tc.managed {
			t.Errorf("%s: %q %v", tc.acc.Status, p, m)
		}
	}
	if SKU(PlanEnterprise) != "seat.enterprise.day" || SKU(PlanTeam) != "seat.team.day" {
		t.Fatal("sku")
	}
}

// TestAllocateProperty: allocation never takes more than a lot has, and parts + rest = amount.
func TestAllocateProperty(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2)) //nolint:gosec // deterministic test sequence
	for range 2000 {
		free := make([]int64, r.IntN(6))
		var total int64
		for i := range free {
			free[i] = r.Int64N(50)
			total += free[i]
		}
		amount := r.Int64N(200)
		parts, rest := allocate(free, amount)
		sum := rest
		for _, p := range parts {
			if p.amount <= 0 || p.amount > free[p.lot] {
				t.Fatalf("bad part %v of %v", p, free)
			}
			sum += p.amount
		}
		if sum != amount || rest != max(0, amount-total) {
			t.Fatalf("free %v amount %d: parts %v rest %d", free, amount, parts, rest)
		}
	}
}
