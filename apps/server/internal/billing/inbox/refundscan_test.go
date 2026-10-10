package inbox

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

// Two replicas share one cadence (ScanGate, like the Redis key): a slot runs once across them,
// and a 429 on one makes both back off.
func TestScanDueAcrossReplicas(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	until := map[string]time.Time{}
	gate := func(_ context.Context, prov string, hold time.Duration, force bool) bool {
		if !force && now.Before(until[prov]) {
			return false
		}
		until[prov] = now.Add(hold)
		return true
	}
	a, b := &Inbox{ScanGate: gate}, &Inbox{ScanGate: gate}
	sa, sb := &scanSchedule{}, &scanSchedule{}
	ctx := context.Background()
	runs := 0
	for range 10 { // ten one-minute ticks, both replicas
		if a.scanDue(ctx, "tochka", sa, time.Minute, now) {
			runs++
		}
		if b.scanDue(ctx, "tochka", sb, time.Minute, now.Add(time.Second)) {
			runs++
		}
		now = now.Add(time.Minute)
	}
	if runs != 10 {
		t.Fatalf("passes %d over 10 minutes and 2 replicas, want 10", runs)
	}
	a.scanDone(ctx, "tochka", sa, fmt.Errorf("list: %w: %w", provider.ErrUnknownOutcome, provider.ErrRateLimited))
	now = now.Add(time.Minute)
	if a.scanDue(ctx, "tochka", sa, time.Minute, now) || b.scanDue(ctx, "tochka", sb, time.Minute, now) {
		t.Fatal("a replica ran during the 429 backoff")
	}
	now = now.Add(time.Minute)
	if !b.scanDue(ctx, "tochka", sb, time.Minute, now) {
		t.Fatal("no pass after the backoff")
	}
	if a.scanDue(ctx, "tochka", sa, 0, now.Add(time.Hour)) {
		t.Fatal("a pass with no cadence")
	}
}

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
