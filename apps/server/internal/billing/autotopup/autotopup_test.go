package autotopup

import "testing"

func TestNeed(t *testing.T) {
	for _, c := range []struct {
		balance, daily int64
		want           bool
	}{
		{-1, 0, true}, {0, 0, false}, {0, 30, true}, {89, 30, true}, {90, 30, false}, {1000, 30, false}, {-5, 30, true},
	} {
		if got := Need(c.balance, c.daily); got != c.want {
			t.Errorf("Need(%d, %d) = %t", c.balance, c.daily, got)
		}
	}
}

func TestAmount(t *testing.T) {
	for _, c := range []struct {
		a, capMinor, minMinor, maxMinor, want int64
	}{
		{900, 50000, 500, 500000, 900},        // formula amount
		{900, 500, 500, 500000, 500},          // owner cap
		{120, 50000, 500, 500000, 500},        // raised to the method minimum
		{0, 50000, 500, 500000, 0},            // nothing to pay
		{900000, 500000, 500, 500000, 500000}, // owner cap = provider maximum
		{900000, 0, 500, 300000, 300000},      // no cap: method maximum
		{120, 400, 500, 500000, 0},            // minimum above the cap: no charge
	} {
		if got := Amount(c.a, c.capMinor, c.minMinor, c.maxMinor); got != c.want {
			t.Errorf("Amount(%d, cap %d, min %d, max %d) = %d, want %d", c.a, c.capMinor, c.minMinor, c.maxMinor, got, c.want)
		}
	}
}

func TestConsentVersion(t *testing.T) {
	if ConsentTexts[ConsentVersion] == "" {
		t.Fatal("the current consent version has no text")
	}
}
