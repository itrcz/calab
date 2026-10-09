package autotopup

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/inbox"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// ThresholdDays is the horizon of the need: an account needs a top-up when its balance pays
// fewer days of the current team than this (or is negative).
const ThresholdDays = 3

// ConsentVersion is the consent text the owner accepts now (PUT …/auto-topup consent_version).
const ConsentVersion = 1

// ConsentTexts are the accepted consent texts by version; the client shows the same text. A
// changed text is a new version (an old consent stays valid for what it said).
var ConsentTexts = map[uint32]string{
	1: "I authorize Calab to charge my saved card automatically when the workspace balance runs low: " +
		"the debt plus 30 days of the current team, at most the cap I set per charge and at most one new charge " +
		"per 24 hours, until I turn auto top-up off.",
}

// Defaults of Options.
const (
	DefaultPoll          = time.Minute
	DefaultBatch         = 50
	DefaultGrace         = 2 * time.Minute
	DefaultRetryWindow   = 23 * time.Hour
	DefaultGiveUpAfter   = 24 * time.Hour
	DefaultChargeTimeout = 90 * time.Second
	// ReconcileWindow: the restore reconcile lists auto-topup payments this far back.
	ReconcileWindow = 48 * time.Hour
	// MinInterval between two new attempts of an account (owner decision).
	MinInterval = 24 * time.Hour
)

// Failure codes the job writes itself (provider decline codes are kept as they are).
const (
	CodeAuthRequired = "authentication_required"
	CodeRevoked      = "consent_revoked"
	CodeSuperseded   = "superseded"
	CodeAbandoned    = "abandoned"
	CodeNotFound     = "not_found"
	CodeRefused      = "provider_refused"
)

var attempts = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "calaba_billing_autotopup_attempts_total",
	Help: "Billing auto-topup attempts by result (dispatched, succeeded, failed, requires_action, unknown, superseded, abandoned, not_found).",
}, []string{"result"})

// Options of the job; zero durations take the defaults.
type Options struct {
	// Enabled (BILLING_AUTO_TOPUP_ENABLED): new attempts may start. Off, open attempts are
	// still resolved (lookups only, no retry of a charge).
	Enabled bool
	// RestoreMarker (BILLING_AUTO_TOPUP_REQUIRE_RECONCILE): non-empty → no new attempt until
	// the reconcile recorded this marker.
	RestoreMarker string
	Poll          time.Duration
	Batch         int
	Grace         time.Duration // an open attempt younger than this is left to its dispatcher
	RetryWindow   time.Duration // same-key retries of an unknown attempt only while younger
	GiveUpAfter   time.Duration // a lookup that finds nothing after this fails the attempt
	ChargeTimeout time.Duration
}

// Job runs the auto-topup attempts. Every instance may run it: the account lock and the
// one-open-attempt index make concurrent ticks safe.
type Job struct {
	db    *db.DB
	core  *core.Core
	reg   *provider.Registry
	inbox *inbox.Inbox
	clock billing.Clock
	opts  Options
	wake  chan struct{}

	mu         sync.Mutex
	reconciled bool                     // RestoreMarker was found reconciled (cached)
	pausedLog  bool                     // the pause was logged
	retry      map[uuid.UUID]retryState // backoff of open attempts being resolved
}

type retryState struct {
	n    int
	next time.Time
}

// New creates the job. clock is the core's clock; in.Mail sends the owner mails.
func New(d *db.DB, c *core.Core, reg *provider.Registry, in *inbox.Inbox, clock billing.Clock, opts Options) *Job {
	if opts.Poll <= 0 {
		opts.Poll = DefaultPoll
	}
	if opts.Batch <= 0 {
		opts.Batch = DefaultBatch
	}
	if opts.Grace <= 0 {
		opts.Grace = DefaultGrace
	}
	if opts.RetryWindow <= 0 {
		opts.RetryWindow = DefaultRetryWindow
	}
	if opts.GiveUpAfter <= 0 {
		opts.GiveUpAfter = DefaultGiveUpAfter
	}
	if opts.ChargeTimeout <= 0 {
		opts.ChargeTimeout = DefaultChargeTimeout
	}
	return &Job{db: d, core: c, reg: reg, inbox: in, clock: clock, opts: opts, wake: make(chan struct{}, 1),
		retry: map[uuid.UUID]retryState{}}
}

// Need reports whether a balance needs a top-up: negative, or paying fewer than ThresholdDays
// days of the daily cost.
func Need(balance, daily int64) bool {
	return balance < 0 || balance < ThresholdDays*daily
}

// Amount is the charge of an attempt: the formula amount a (debt + 30 days) capped by the
// owner's cap and the method maximum, raised to the method minimum. 0 = no charge (nothing
// to pay, or the minimum is above the owner's cap).
func Amount(a, capMinor, minMinor, maxMinor int64) int64 {
	if a <= 0 {
		return 0
	}
	if maxMinor > 0 {
		a = min(a, maxMinor)
	}
	if capMinor > 0 {
		a = min(a, capMinor)
	}
	a = max(a, minMinor)
	if capMinor > 0 && a > capMinor {
		return 0
	}
	return a
}

// Wake makes the job look for work now (after a committed billing change: a renewal debit
// may have lowered a balance).
func (j *Job) Wake() {
	select {
	case j.wake <- struct{}{}:
	default:
	}
}

// Run ticks every Poll (and at once after Wake) until ctx is done. Idle cost: one probe of the
// open attempts and one scan of the live consents per tick.
func (j *Job) Run(ctx context.Context) {
	t := time.NewTicker(j.opts.Poll)
	defer t.Stop()
	for {
		j.Tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-j.wake:
		}
	}
}

// Tick resolves open attempts, then (enabled and not paused) starts the attempts that are due.
// Returns how many attempts were dispatched.
func (j *Job) Tick(ctx context.Context) int {
	if err := j.Recover(ctx); err != nil && ctx.Err() == nil {
		slog.WarnContext(ctx, "billing auto-topup: recover", "err", err)
	}
	if !j.opts.Enabled {
		return 0
	}
	paused, err := j.Paused(ctx)
	if err != nil {
		slog.WarnContext(ctx, "billing auto-topup: restore marker", "err", err)
		return 0
	}
	if paused {
		j.mu.Lock()
		if !j.pausedLog {
			j.pausedLog = true
			slog.WarnContext(ctx, "billing auto-topup: paused until the restore reconcile (BILLING_AUTO_TOPUP_REQUIRE_RECONCILE)",
				"marker", j.opts.RestoreMarker)
		}
		j.mu.Unlock()
		return 0
	}
	now, err := j.clock.Now(ctx, j.db.Q)
	if err != nil {
		slog.WarnContext(ctx, "billing auto-topup: clock", "err", err)
		return 0
	}
	ids, err := j.db.Q.ListBillingAutoTopupCandidates(ctx, sqlc.ListBillingAutoTopupCandidatesParams{Now: now, Lim: int32(j.opts.Batch)}) //nolint:gosec // small
	if err != nil {
		slog.WarnContext(ctx, "billing auto-topup: candidates", "err", err)
		return 0
	}
	n := 0
	for _, id := range ids {
		if ctx.Err() != nil {
			break
		}
		ok, err := j.TryAccount(ctx, id)
		if err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "billing auto-topup: account", "account", id, "err", err)
		}
		if ok {
			n++
		}
	}
	return n
}

// AttemptSettled is the inbox hook (inbox.Inbox.AttemptSettled): the payment of an attempt was
// credited in this transaction (account locked) → the attempt succeeded, whatever it said.
func (j *Job) AttemptSettled(ctx context.Context, q *sqlc.Queries, attemptID uuid.UUID, pay sqlc.BillingPayment) error {
	now, err := j.clock.Now(ctx, q)
	if err != nil {
		return err
	}
	_, err = q.SettleBillingAutoTopupAttemptPaid(ctx, sqlc.SettleBillingAutoTopupAttemptPaidParams{
		ProviderPaymentID: &pay.ProviderPaymentID, Now: now, ID: attemptID,
	})
	if db.IsNotFound(err) {
		return nil // already succeeded
	}
	if err == nil {
		attempts.WithLabelValues("succeeded").Inc()
	}
	return err
}

// OwnerChanged revokes the auto-topup consent of a workspace whose owner changes, in the
// caller's transaction (which locked the workspace row first). The consent belongs to the
// person who gave it; the new owner gives their own. Dispatch also refuses a consent whose
// consent_by is not the current owner, so a path that forgets this hook still cannot charge.
func OwnerChanged(ctx context.Context, q *sqlc.Queries, workspaceID uuid.UUID) error {
	acc, err := q.LockLiveBillingAccountByWorkspace(ctx, &workspaceID)
	if db.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	now, err := billing.DBClock{}.Now(ctx, q)
	if err != nil {
		return err
	}
	_, err = q.RevokeBillingAutoTopup(ctx, sqlc.RevokeBillingAutoTopupParams{Now: now, Reason: "owner_changed", AccountID: acc.ID})
	return err
}
