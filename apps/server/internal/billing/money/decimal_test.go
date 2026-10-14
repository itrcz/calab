package money

import (
	"errors"
	"math"
	"testing"
)

func TestParseDecimal(t *testing.T) {
	for _, c := range []struct {
		in   string
		want int64
	}{
		{"0", 0}, {"1", 100}, {"1.0", 100}, {"1.5", 150}, {"150.00", 15000}, {"0.33", 33}, {"500000", 50000000},
		{"1.000", 100}, {"-0.05", -5}, {"92233720368547758.07", math.MaxInt64},
	} {
		got, err := ParseDecimal(c.in, RUB)
		if err != nil || got.Minor != c.want || got.Currency != RUB {
			t.Errorf("ParseDecimal(%q) = %v, %v; want %d", c.in, got, err, c.want)
		}
	}
	for _, bad := range []string{"", ".", "1.", ".5", "1.005", "1e2", "+1", "1,5", " 1", "abc", "92233720368547758.08", "1.2.3", "--1", "-"} {
		if _, err := ParseDecimal(bad, RUB); err == nil {
			t.Errorf("ParseDecimal(%q) accepted", bad)
		}
	}
	if _, err := ParseDecimal("1", Currency("EUR")); !errors.Is(err, ErrUnknownCurrency) {
		t.Errorf("EUR: %v", err)
	}
}

func TestDecimal(t *testing.T) {
	for _, c := range []struct {
		m    Money
		want string
	}{{New(15000, RUB), "150.00"}, {New(1, RUB), "0.01"}, {New(-5, USD), "-0.05"}, {New(0, RUB), "0.00"}} {
		if got := c.m.Decimal(); got != c.want {
			t.Errorf("%v.Decimal() = %q, want %q", c.m, got, c.want)
		}
	}
}
