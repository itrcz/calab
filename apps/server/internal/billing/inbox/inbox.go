// Package inbox turns provider facts into money exactly once (ADR-0080 v5 «v1 cut», T5): the
// webhook inbox, the pull-sync of checkouts and payments, and the reconciliation that finds
// what webhooks missed.
//
// # Webhooks
//
// Receive verifies the signature on the raw body (provider.ParseWebhook), stores the event in
// billing_provider_events (ON CONFLICT DO NOTHING: a redelivery is a no-op) and returns; the
// HTTP handler answers 200 at once. A worker (Run / ProcessOnce) claims due events with a lease
// (FOR UPDATE SKIP LOCKED), processes them and records the outcome: processed, retry with
// backoff (transient: provider unreachable, payment not recorded yet), or dead with the error
// (orphan: no customer mapping, currency / account mismatch, too many attempts).
//
// # One credit per payment
//
// An event is only a hint. Every money effect re-reads the object from the provider first
// (GetPayment / GetCheckout / GetRefund / GetDispute) and checks it against our rows: the
// payment's customer must be one of ours (billing_customers maps provider account + livemode +
// customer to the billing account), the currency the account's, status succeeded with
// amount_received > 0. Then one transaction locks the account, records the payment
// (billing_payments UNIQUE(provider, provider_account, livemode, provider_payment_id), insert
// ON CONFLICT DO NOTHING) and calls core.CreditPayment, which creates the payment's single
// funding lot. Checkout completed + payment_intent.succeeded + charge events, redeliveries,
// the success-redirect pull-sync and the reconciliation all end in this one path, serialized
// by the account lock, so the payment is credited once whatever arrives first.
//
// # Network and transactions
//
// Provider calls happen before the transaction (reads) — never inside it. A crash between the
// read and the commit just repeats the read on the next attempt.
package inbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Defaults of Options.
const (
	DefaultPoll           = 5 * time.Second
	DefaultBatch          = 50
	DefaultLease          = time.Minute
	DefaultMaxAttempts    = 20
	DefaultReconcileEvery = 5 * time.Minute
	DefaultImportEvery    = time.Hour
	// DefaultStaleCheckout: an open checkout older than this is pulled from the provider
	// (abandoned page, lost redirect); one without a provider session is canceled.
	DefaultStaleCheckout = 30 * time.Minute
	// DefaultImportWindow: the periodic import lists payments of recently active customers
	// created within this window.
	DefaultImportWindow = 48 * time.Hour
)

var (
	eventsProcessed = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "calaba_billing_provider_events_total",
		Help: "Billing provider webhook events processed by the inbox, by kind and result (ok, retry, dead).",
	}, []string{"kind", "result"})
	credits = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "calaba_billing_payments_credited_total",
		Help: "Provider payments credited to a billing balance, by path (webhook, pull, reconcile).",
	}, []string{"path"})
)

// Options of the inbox; zero values take the defaults.
type Options struct {
	Poll           time.Duration
	Batch          int
	Lease          time.Duration
	MaxAttempts    int32
	ReconcileEvery time.Duration
	ImportEvery    time.Duration
	StaleCheckout  time.Duration
	ImportWindow   time.Duration
}

// Inbox processes provider facts.
type Inbox struct {
	db   *db.DB
	reg  *provider.Registry
	core *core.Core
	opts Options
	wake chan struct{}

	// Committed runs after a transaction of the inbox changed an account (credit, refund,
	// dispute): plans.Invalidate, WORKSPACE_UPDATE / BILLING_UPDATE and state mails (wiring).
	Committed func(ctx context.Context, acc sqlc.BillingAccount)
	// Mail queues the owner mails of payments, refunds and disputes (nil = no mail).
	Mail *Notifier
	// AttemptSettled (T7 auto-topup) runs inside the credit transaction of a payment of an
	// auto-topup attempt, after the payment row is written: the attempt follows its payment.
	AttemptSettled func(ctx context.Context, q *sqlc.Queries, attemptID uuid.UUID, pay sqlc.BillingPayment) error
}

// New creates the inbox.
func New(d *db.DB, reg *provider.Registry, c *core.Core, opts Options) *Inbox {
	if opts.Poll <= 0 {
		opts.Poll = DefaultPoll
	}
	if opts.Batch <= 0 {
		opts.Batch = DefaultBatch
	}
	if opts.Lease <= 0 {
		opts.Lease = DefaultLease
	}
	if opts.MaxAttempts <= 0 {
		opts.MaxAttempts = DefaultMaxAttempts
	}
	if opts.ReconcileEvery <= 0 {
		opts.ReconcileEvery = DefaultReconcileEvery
	}
	if opts.ImportEvery <= 0 {
		opts.ImportEvery = DefaultImportEvery
	}
	if opts.StaleCheckout <= 0 {
		opts.StaleCheckout = DefaultStaleCheckout
	}
	if opts.ImportWindow <= 0 {
		opts.ImportWindow = DefaultImportWindow
	}
	return &Inbox{db: d, reg: reg, core: c, opts: opts, wake: make(chan struct{}, 1)}
}

// permanentError: retrying cannot help (orphan, mismatch, refused by the provider).
type permanentError struct{ err error }

func (e permanentError) Error() string { return e.err.Error() }
func (e permanentError) Unwrap() error { return e.err }

func permanent(format string, args ...any) error {
	return permanentError{fmt.Errorf(format, args...)}
}

// IsPermanent reports whether err will not go away by retrying.
func IsPermanent(err error) bool {
	var p permanentError
	return errors.As(err, &p)
}

// Errors of the money checks (permanent).
var (
	ErrOrphan   = errors.New("billing inbox: no local customer / payment for the provider object")
	ErrMismatch = errors.New("billing inbox: provider object does not match the account")
)

// payload is the minimal event copy kept in billing_provider_events (ids and metadata only).
type payload struct {
	Type      string            `json:"type"`
	PaymentID string            `json:"payment_id,omitempty"`
	Created   int64             `json:"created"`
	Metadata  map[string]string `json:"metadata,omitempty"`
}

// Receive verifies and stores one webhook delivery. Errors: provider.ErrBadSignature and
// provider.ErrLivemodeForbidden (answer 400, nothing stored), anything else is transient for
// the sender (5xx: it redelivers). duplicate = the event was stored before.
func (in *Inbox) Receive(ctx context.Context, p provider.Provider, h http.Header, raw []byte) (ev provider.Event, duplicate bool, err error) {
	ev, err = p.ParseWebhook(ctx, h, raw)
	if err != nil {
		return ev, false, err
	}
	pl, err := json.Marshal(payload{Type: ev.Type, PaymentID: ev.PaymentID, Created: ev.Created.Unix(), Metadata: ev.Metadata.Map()})
	if err != nil {
		return ev, false, err
	}
	_, err = db.GuardValue(ctx, in.db, func(q *sqlc.Queries) (uuid.UUID, error) {
		return q.InsertBillingProviderEvent(ctx, sqlc.InsertBillingProviderEventParams{
			Provider: string(ev.Provider), ProviderAccount: ev.ProviderAccount, Livemode: ev.Livemode, EventID: ev.EventID,
			Kind: string(ev.Kind), ObjectID: ev.ObjectID, Payload: pl,
		})
	})
	if db.IsNotFound(err) {
		return ev, true, nil
	}
	if err != nil {
		return ev, false, err
	}
	in.Wake()
	return ev, false, nil
}

// Wake makes the worker look for due events now.
func (in *Inbox) Wake() {
	select {
	case in.wake <- struct{}{}:
	default:
	}
}

// Run processes due events until ctx is done (every Poll, at once after Wake). Idle cost: one
// probe of the partial index of unprocessed events per tick.
func (in *Inbox) Run(ctx context.Context) {
	t := time.NewTicker(in.opts.Poll)
	defer t.Stop()
	for {
		if _, err := in.ProcessOnce(ctx); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "billing inbox: process", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-in.wake:
		}
	}
}

func interval(d time.Duration) pgtype.Interval {
	return pgtype.Interval{Microseconds: d.Microseconds(), Valid: true}
}

// backoff before attempt n+1: 10 s doubling, capped at 1 h.
func backoff(attempts int32) time.Duration {
	if attempts >= 9 {
		return time.Hour
	}
	return min(10*time.Second<<max(attempts-1, 0), time.Hour)
}

// ProcessOnce processes the due events (several batches) and returns how many it finished.
func (in *Inbox) ProcessOnce(ctx context.Context) (int, error) {
	done := 0
	for range 20 {
		now, err := billing.DBClock{}.Now(ctx, in.db.Q)
		if err != nil {
			return done, err
		}
		rows, err := db.GuardValue(ctx, in.db, func(q *sqlc.Queries) ([]sqlc.BillingProviderEvent, error) {
			return q.ClaimBillingProviderEvents(ctx, sqlc.ClaimBillingProviderEventsParams{Now: now, Lease: interval(in.opts.Lease), Lim: int32(in.opts.Batch)}) //nolint:gosec // small
		})
		if err != nil {
			return done, err
		}
		for _, row := range rows {
			in.finish(ctx, row, in.process(ctx, row))
			done++
		}
		if len(rows) < in.opts.Batch {
			return done, nil
		}
	}
	return done, nil
}

func (in *Inbox) finish(ctx context.Context, row sqlc.BillingProviderEvent, err error) {
	log := slog.With("event", row.EventID, "kind", row.Kind, "object", row.ObjectID, "attempt", row.Attempts)
	now := time.Now()
	var markErr error
	switch {
	case err == nil:
		eventsProcessed.WithLabelValues(row.Kind, "ok").Inc()
		markErr = db.GuardExec(ctx, in.db, func(q *sqlc.Queries) error {
			return q.MarkBillingProviderEventProcessed(ctx, sqlc.MarkBillingProviderEventProcessedParams{Now: now, ID: row.ID})
		})
	case IsPermanent(err) || row.Attempts >= in.opts.MaxAttempts:
		eventsProcessed.WithLabelValues(row.Kind, "dead").Inc()
		log.ErrorContext(ctx, "billing inbox: event not processed", "err", err)
		markErr = db.GuardExec(ctx, in.db, func(q *sqlc.Queries) error {
			return q.MarkBillingProviderEventDead(ctx, sqlc.MarkBillingProviderEventDeadParams{Now: now, Error: clip(err.Error()), ID: row.ID})
		})
	default:
		eventsProcessed.WithLabelValues(row.Kind, "retry").Inc()
		log.WarnContext(ctx, "billing inbox: event will be retried", "err", err)
		markErr = db.GuardExec(ctx, in.db, func(q *sqlc.Queries) error {
			return q.MarkBillingProviderEventRetry(ctx, sqlc.MarkBillingProviderEventRetryParams{
				NextAttemptAt: now.Add(backoff(row.Attempts)), Error: clip(err.Error()), ID: row.ID,
			})
		})
	}
	if markErr != nil && ctx.Err() == nil {
		log.WarnContext(ctx, "billing inbox: record outcome", "err", markErr)
	}
}

func clip(s string) string {
	if len(s) > 500 {
		return s[:500]
	}
	return s
}

// event rebuilds the provider event of a stored row.
func event(row sqlc.BillingProviderEvent) provider.Event {
	var pl payload
	_ = json.Unmarshal(row.Payload, &pl)
	return provider.Event{
		Provider: provider.ID(row.Provider), ProviderAccount: row.ProviderAccount, Livemode: row.Livemode, EventID: row.EventID,
		Kind: provider.EventKind(row.Kind), Type: pl.Type, ObjectID: row.ObjectID, PaymentID: pl.PaymentID,
		Created: time.Unix(pl.Created, 0).UTC(), Metadata: provider.ParseMetadata(pl.Metadata),
	}
}

func (in *Inbox) process(ctx context.Context, row sqlc.BillingProviderEvent) error {
	ev := event(row)
	switch ev.Kind {
	case provider.EventIgnored, provider.EventMethodSaved:
		// Cards are saved from the payment of a checkout with save_method (SyncPayment); a
		// method attached elsewhere is not ours to use.
		return nil
	}
	p, ok := in.reg.Provider(ev.Provider)
	if !ok {
		return fmt.Errorf("billing inbox: provider %q is not configured", ev.Provider)
	}
	switch ev.Kind {
	case provider.EventCheckoutCompleted, provider.EventCheckoutExpired:
		return in.checkoutEvent(ctx, p, ev)
	case provider.EventPaymentSucceeded, provider.EventPaymentProcessing, provider.EventPaymentFailed:
		if isSession(ev.ObjectID) {
			return in.checkoutEvent(ctx, p, ev) // checkout.session.async_payment_failed
		}
		id := ev.PaymentID
		if id == "" {
			id = ev.ObjectID
		}
		_, err := in.SyncPayment(ctx, p, id, "webhook")
		return err
	case provider.EventRefundUpdated:
		return in.refundEvent(ctx, p, ev)
	case provider.EventDisputeOpened, provider.EventDisputeClosed:
		return in.disputeEvent(ctx, p, ev)
	case provider.EventMethodDetached:
		return in.methodDetached(ctx, ev.ObjectID)
	}
	return nil
}

func isSession(id string) bool { return len(id) > 3 && id[:3] == "cs_" }

// committed notifies after a commit.
func (in *Inbox) committed(ctx context.Context, acc sqlc.BillingAccount) {
	if in.Committed != nil && acc.ID != uuid.Nil {
		in.Committed(ctx, acc)
	}
	in.Mail.Wake()
}
