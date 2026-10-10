package inbox

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Polling of pending checkouts (ADR-0083). A provider with CapSuccessOnlyWebhooks (Tochka)
// pushes only successful payments: a payment page that expires or fails says nothing, and a
// success webhook may be lost after the bank's 30 retries. Its open checkouts are therefore
// pulled on a backoff from the moment the page exists (SchedulePoll) until they leave 'open':
// 30 s, 1, 2, 4, 8 min, then every 15 min. The owner's own poll of GET …/checkouts/{id} pulls
// sooner while the app waits; webhook, poll and reconciliation all end in the one credit path.

// DefaultPollTick is how often due polls are looked for (one index probe when none is due).
const DefaultPollTick = 15 * time.Second

// pollBatch bounds the checkouts one tick pulls.
const pollBatch = 50

// PollDelay is the wait before poll n+1 of a checkout (n polls done).
func PollDelay(n int32) time.Duration {
	if n >= 5 {
		return 15 * time.Minute
	}
	return 30 * time.Second << n
}

// SchedulePoll arms the first poll of a checkout whose provider page was just created, when its
// provider has no failure / expiry webhooks.
func (in *Inbox) SchedulePoll(ctx context.Context, p provider.Provider, checkoutID uuid.UUID) {
	if !p.Caps().Has(provider.CapSuccessOnlyWebhooks) {
		return
	}
	at := time.Now().Add(PollDelay(0))
	if err := db.GuardExec(ctx, in.db, func(q *sqlc.Queries) error {
		return q.ScheduleBillingCheckoutPoll(ctx, sqlc.ScheduleBillingCheckoutPollParams{At: &at, Inc: 0, ID: checkoutID})
	}); err != nil {
		slog.WarnContext(ctx, "billing poll: schedule", "checkout", checkoutID, "err", err)
	}
}

// RunPoll pulls due checkouts every DefaultPollTick until ctx is done.
func (in *Inbox) RunPoll(ctx context.Context) {
	t := time.NewTicker(DefaultPollTick)
	defer t.Stop()
	for {
		in.PollOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// PollOnce pulls the open checkouts whose poll is due and schedules the next one of those still
// open. Returns how many it pulled.
func (in *Inbox) PollOnce(ctx context.Context) int {
	now, err := billing.DBClock{}.Now(ctx, in.db.Q)
	if err != nil {
		return 0
	}
	cos, err := in.db.Q.ListBillingCheckoutsToPoll(ctx, sqlc.ListBillingCheckoutsToPollParams{Now: now, Lim: pollBatch})
	if err != nil {
		if ctx.Err() == nil {
			slog.WarnContext(ctx, "billing poll: list", "err", err)
		}
		return 0
	}
	for _, co := range cos {
		res, err := in.SyncCheckout(ctx, co, "poll")
		if err != nil {
			slog.WarnContext(ctx, "billing poll: checkout", "checkout", co.ID, "polls", co.Polls, "err", err)
		}
		if err == nil && res.Checkout.Status != CheckoutOpen {
			continue
		}
		var at *time.Time // a permanent error stops polling: the reconciliation pass handles it
		if err == nil || !IsPermanent(err) {
			next := time.Now().Add(PollDelay(co.Polls + 1))
			at = &next
		}
		if err := db.GuardExec(ctx, in.db, func(q *sqlc.Queries) error {
			return q.ScheduleBillingCheckoutPoll(ctx, sqlc.ScheduleBillingCheckoutPollParams{At: at, Inc: 1, ID: co.ID})
		}); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "billing poll: reschedule", "checkout", co.ID, "err", err)
		}
	}
	return len(cos)
}
