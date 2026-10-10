package inbox

import (
	"testing"
	"time"
)

// The refund polling cadence (owner 2026-10-10): every minute for 24 h after the last payment or
// refund, every 5 minutes for 7 days, every 15 minutes up to 180 days, then never.
func TestScanInterval(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		age  time.Duration
		want time.Duration
	}{
		{0, time.Minute},
		{23 * time.Hour, time.Minute},
		{25 * time.Hour, 5 * time.Minute},
		{6 * 24 * time.Hour, 5 * time.Minute},
		{8 * 24 * time.Hour, 15 * time.Minute},
		{179 * 24 * time.Hour, 15 * time.Minute},
		{181 * 24 * time.Hour, 0},
	} {
		if got := scanInterval(now.Add(-c.age), now); got != c.want {
			t.Errorf("age %v: %v, want %v", c.age, got, c.want)
		}
	}
	if got := scanInterval(time.Unix(0, 0), now); got != 0 {
		t.Errorf("no activity: %v", got)
	}
	if got := scanInterval(time.Time{}, now); got != 0 {
		t.Errorf("zero: %v", got)
	}
}
