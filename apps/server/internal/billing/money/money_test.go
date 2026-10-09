package money

import (
	"errors"
	"math"
	"testing"
	"time"
)

func TestProrateM18(t *testing.T) {
	// M18: one Team seat (10 cents per 24 h), 6 h until the deadline → 2.5 → 3 cents.
	got, err := Prorate(10, int64(6*time.Hour/time.Second), int64(24*time.Hour/time.Second))
	if err != nil || got != 3 {
		t.Fatalf("M18 = %d, %v; want 3", got, err)
	}
	// Full day, zero, and the exact half rounds up.
	for _, c := range []struct{ amount, part, whole, want int64 }{
		{10, 86400, 86400, 10},
		{10, 0, 86400, 0},
		{1, 1, 2, 1},
		{1, 1, 3, 0},
		{2, 1, 3, 1},  // 0.667 → 1
		{30, 1, 4, 8}, // 7.5 → 8
		{100, 1, 3, 33},
		{200, 1, 3, 67}, // 66.67 → 67
	} {
		got, err := Prorate(c.amount, c.part, c.whole)
		if err != nil || got != c.want {
			t.Errorf("Prorate(%d, %d, %d) = %d, %v; want %d", c.amount, c.part, c.whole, got, err, c.want)
		}
	}
	if _, err := Prorate(10, 2, 1); err == nil {
		t.Error("part > whole accepted")
	}
}

func TestMulDivHalfUp(t *testing.T) {
	// 128-bit intermediate: MaxInt64 × 3 / 3 is exact.
	got, err := MulDivHalfUp(math.MaxInt64, 3, 3)
	if err != nil || got != math.MaxInt64 {
		t.Fatalf("exact big = %d, %v", got, err)
	}
	if _, err := MulDivHalfUp(math.MaxInt64, 2, 1); !errors.Is(err, ErrOverflow) {
		t.Fatalf("overflow: %v", err)
	}
	if _, err := MulDivHalfUp(1, 1, 0); !errors.Is(err, ErrDivisionByZero) {
		t.Fatalf("div0: %v", err)
	}
	if _, err := MulDivHalfUp(-1, 1, 1); !errors.Is(err, ErrNegative) {
		t.Fatalf("negative: %v", err)
	}
	// Rounding at the top of the range: (2^63-1) × 1 / 2 = 4611686018427387903.5 → …904.
	got, err = MulDivHalfUp(math.MaxInt64, 1, 2)
	if err != nil || got != 4611686018427387904 {
		t.Fatalf("half of max = %d, %v", got, err)
	}
}

func TestApplyDiscountBps(t *testing.T) {
	for _, c := range []struct {
		unit int64
		bps  int
		want int64
	}{
		{10, 0, 10},
		{10, 1000, 9}, // M8: 10 % off 10 cents
		{10, 10000, 0},
		{30, 2500, 23}, // 22.5 → 23
		{10, 500, 10},  // 9.5 → 10
		{600, 1000, 540},
	} {
		got, err := ApplyDiscountBps(c.unit, c.bps)
		if err != nil || got != c.want {
			t.Errorf("ApplyDiscountBps(%d, %d) = %d, %v; want %d", c.unit, c.bps, got, err, c.want)
		}
	}
	for _, bad := range []int{-1, 10001} {
		if _, err := ApplyDiscountBps(10, bad); err == nil {
			t.Errorf("bps %d accepted", bad)
		}
	}
}

func TestMoneyArithmetic(t *testing.T) {
	a, b := New(1000, USD), New(-1100, USD)
	s, err := a.Add(b)
	if err != nil || s != New(-100, USD) {
		t.Fatalf("add = %v, %v", s, err)
	}
	if _, err := a.Add(New(1, RUB)); !errors.Is(err, ErrCurrencyMismatch) {
		t.Fatalf("mixed currency: %v", err)
	}
	if _, err := New(math.MaxInt64, USD).Add(New(1, USD)); !errors.Is(err, ErrOverflow) {
		t.Fatalf("overflow: %v", err)
	}
	if _, err := New(0, USD).Sub(New(math.MinInt64, USD)); !errors.Is(err, ErrOverflow) {
		t.Fatalf("sub overflow: %v", err)
	}
	if _, err := MulMinor(math.MaxInt64, 2); !errors.Is(err, ErrOverflow) {
		t.Fatalf("mul overflow: %v", err)
	}
	if p, err := MulMinor(10, 500); err != nil || p != 5000 {
		t.Fatalf("mul = %d, %v", p, err)
	}
	if c, _ := a.Cmp(New(999, USD)); c != 1 {
		t.Fatal("cmp")
	}
	for m, want := range map[Money]string{
		New(1234, USD): "USD 12.34", New(-5, RUB): "RUB -0.05", New(0, USD): "USD 0.00",
		New(math.MinInt64, USD): "USD -92233720368547758.08",
	} {
		if got := m.String(); got != want {
			t.Errorf("String = %q, want %q", got, want)
		}
	}
	if _, err := ParseCurrency("EUR"); err == nil {
		t.Fatal("EUR accepted")
	}
	if c, err := ParseCurrency("USD"); err != nil || c != USD {
		t.Fatal("USD refused")
	}
}
