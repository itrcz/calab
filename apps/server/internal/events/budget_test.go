package events

import (
	"context"
	"testing"
	"time"
)

// Detached: not canceled with the request, bounded by the remaining request budget, which
// is charged only with time actually spent; once used up, later calls fail at once.
func TestDetachedBudget(t *testing.T) {
	req, cancel := context.WithCancel(context.Background())
	ctx := WithBudget(req, 60*time.Millisecond)
	cancel() // the client went away: post-commit work must still run

	d1, done1 := Detached(ctx, time.Hour)
	if d1.Err() != nil {
		t.Fatal("detached context canceled together with the request")
	}
	if dl, ok := d1.Deadline(); !ok || time.Until(dl) > 60*time.Millisecond {
		t.Fatalf("deadline not bounded by the budget: %v %v", dl, ok)
	}
	<-d1.Done() // a hung publish waits out the whole budget
	done1()

	time.Sleep(20 * time.Millisecond) // time outside publishing is not charged … but the budget is gone
	d2, done2 := Detached(ctx, time.Hour)
	defer done2()
	if d2.Err() == nil {
		t.Fatal("exhausted budget still allows waiting")
	}

	// Outside a request: the fallback per call.
	d3, done3 := Detached(context.Background(), 30*time.Millisecond)
	defer done3()
	if dl, ok := d3.Deadline(); !ok || time.Until(dl) > 30*time.Millisecond {
		t.Fatal("fallback timeout not applied")
	}
}

// Only elapsed time is charged: quick publishes leave the budget for later ones.
func TestDetachedBudgetChargesElapsed(t *testing.T) {
	ctx := WithBudget(context.Background(), 2*time.Second)
	for range 50 {
		_, done := Detached(ctx, time.Hour)
		done()
	}
	d, done := Detached(ctx, time.Hour)
	defer done()
	if dl, ok := d.Deadline(); !ok || time.Until(dl) < 1500*time.Millisecond {
		t.Fatalf("fast publishes used up the budget: %v left", time.Until(dl))
	}
}
