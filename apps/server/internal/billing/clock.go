package billing

import (
	"context"
	"sync"
	"time"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Day is the length of one paid seat interval (ADR-0080 §4.2: full 24 hours, not calendar days).
const Day = 24 * time.Hour

// Clock is the time of billing decisions: deadlines, renewals, quote expiry. Production uses
// database time (DBClock) so every API instance agrees; tests and the dev-only test clock
// (BILLING_TEST_CLOCK=1) use FakeClock. Pass the result to queries as their now argument.
type Clock interface {
	// Now returns the current time; q is the transaction the decision is made in (call it
	// after LockBillingAccount so the time is not older than the lock).
	Now(ctx context.Context, q *sqlc.Queries) (time.Time, error)
}

// DBClock reads clock_timestamp() of the database.
type DBClock struct{}

// Now implements Clock.
func (DBClock) Now(ctx context.Context, q *sqlc.Queries) (time.Time, error) {
	t, err := q.BillingNow(ctx)
	if err != nil {
		return time.Time{}, err
	}
	return t.UTC(), nil
}

// FakeClock is a settable clock for tests. The zero value is not usable: NewFakeClock.
type FakeClock struct {
	mu sync.Mutex
	t  time.Time
}

// NewFakeClock starts at t.
func NewFakeClock(t time.Time) *FakeClock { return &FakeClock{t: t.UTC()} }

// Now implements Clock (q is ignored).
func (c *FakeClock) Now(context.Context, *sqlc.Queries) (time.Time, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t, nil
}

// Time returns the current fake time.
func (c *FakeClock) Time() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

// Set moves the clock to t (also backwards: a test may need it; production never does).
func (c *FakeClock) Set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = t.UTC()
}

// Advance moves the clock forward by d.
func (c *FakeClock) Advance(d time.Duration) time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
	return c.t
}

// SwitchClock is the clock behind the dev-only test clock endpoint: the database clock until
// Set, then a fixed time that the endpoint moves. Never constructed unless BILLING_TEST_CLOCK=1.
type SwitchClock struct {
	mu    sync.Mutex
	fixed *time.Time
}

// Now implements Clock.
func (c *SwitchClock) Now(ctx context.Context, q *sqlc.Queries) (time.Time, error) {
	c.mu.Lock()
	f := c.fixed
	c.mu.Unlock()
	if f != nil {
		return *f, nil
	}
	return DBClock{}.Now(ctx, q)
}

// Set fixes the time; nil returns to the database clock.
func (c *SwitchClock) Set(t *time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if t == nil {
		c.fixed = nil
		return
	}
	u := t.UTC()
	c.fixed = &u
}

// Provider-facing timestamps (checkout expires_at, list filters) are real time: the provider
// runs on the wall clock, the billing Clock only orders our ledger and scheduling. A billing
// clock moved ahead (dev test clock) must neither push an expiry beyond what the provider
// accepts nor hide payments it made "before" the billing time.

// ProviderSince is the lower bound of a provider-side "created at or after" filter: the earlier
// of the billing time and the wall clock, minus window.
func ProviderSince(billingNow time.Time, window time.Duration) time.Time {
	t := time.Now().UTC()
	if billingNow.Before(t) {
		t = billingNow
	}
	return t.Add(-window)
}
