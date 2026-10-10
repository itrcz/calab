package core

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// The custom price rule (ADR-0086 «Индивидуальный тариф»): the newest version whose effective_from
// has come applies, so a later version replaces one scheduled after its start.
func TestCustomPriceAt(t *testing.T) {
	t0 := time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC)
	day := func(n int) time.Time { return t0.Add(time.Duration(n) * billing.Day) }
	v := func(id string, unit int64, from, created time.Time) sqlc.BillingPrice {
		return sqlc.BillingPrice{ID: uuid.MustParse(id), UnitMinor: unit, EffectiveFrom: from, CreatedAt: created}
	}
	a := v("00000000-0000-0000-0000-00000000000a", 10, day(0), day(0))
	b := v("00000000-0000-0000-0000-00000000000b", 20, day(10), day(1)) // scheduled on day 1 for day 10
	c := v("00000000-0000-0000-0000-00000000000c", 15, day(5), day(2))  // day 2: from day 5 — replaces b
	all := []sqlc.BillingPrice{a, b, c}
	for _, tc := range []struct {
		at   time.Time
		want int64
	}{{day(0), 10}, {day(4), 10}, {day(5), 15}, {day(11), 15}} {
		if p, ok := CustomPriceAt(all, tc.at); !ok || p.UnitMinor != tc.want {
			t.Fatalf("price at %s: %d, want %d", tc.at, p.UnitMinor, tc.want)
		}
	}
	if _, ok := CustomPriceAt(all, day(-1)); ok {
		t.Fatal("a price before the first version")
	}
	if p, at, ok := NextCustomPrice(all, day(3)); !ok || p.UnitMinor != 15 || !at.Equal(day(5)) {
		t.Fatalf("next %d at %s %v", p.UnitMinor, at, ok)
	}
	if _, _, ok := NextCustomPrice(all, day(6)); ok {
		t.Fatal("b is replaced: no next price")
	}
	if p, at, ok := NextCustomPrice([]sqlc.BillingPrice{a, b}, day(3)); !ok || p.UnitMinor != 20 || !at.Equal(day(10)) {
		t.Fatalf("next of a, b: %d at %s %v", p.UnitMinor, at, ok)
	}
}
