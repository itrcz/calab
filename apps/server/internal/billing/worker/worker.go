// Package worker runs the scheduled work of balance billing (ADR-0080 §4.3, §8): renewal of
// seat lots at their boundaries, the end of a stopped account's paid coverage, suspension at
// the debt deadline, and the nightly integrity check. Every instance may run it: accounts are
// claimed with FOR UPDATE SKIP LOCKED, one account per transaction. The logic is in
// billing/core (core.ProcessDue, core.CheckIntegrity); this package only schedules it.
//
// Wiring (T5, internal/app): run Worker.Run only if BILLING_ENABLED && BILLING_DEBITS_ENABLED
// (Enabled); run Worker.RunIntegrity if BILLING_ENABLED.
package worker

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/config"
)

// Defaults: a renewal is at most Poll late (ADR-0080 §4.3: poll ≤ 1 min; spending actions catch
// up themselves before acting), Batch accounts per kind and tick, integrity once a day.
const (
	DefaultPoll           = 30 * time.Second
	DefaultBatch          = 200
	DefaultIntegrityEvery = 24 * time.Hour
)

var (
	processed = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "calaba_billing_due_accounts_total",
		Help: "Billing accounts processed by the due worker, by kind (renewal, coverage, suspension) and result.",
	}, []string{"kind", "result"})
	mismatches = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "calaba_billing_integrity_mismatches",
		Help: "Billing accounts failing the last integrity check (ledger: sum(ledger) = balance; funding: balance = free advance - debt).",
	}, []string{"check"})
)

// Enabled reports whether the due worker may run (renewals are debits).
func Enabled(b config.Billing) bool { return b.Enabled && b.DebitsEnabled }

// Options of the worker; zero values take the defaults.
type Options struct {
	Poll           time.Duration
	Batch          int
	IntegrityEvery time.Duration
	// Suspend: apply suspensions at the deadline (BILLING_ENFORCEMENT_ENABLED).
	Suspend bool
}

// Worker schedules core.ProcessDue and core.CheckIntegrity.
type Worker struct {
	core *core.Core
	opts Options
}

// New creates the worker.
func New(c *core.Core, opts Options) *Worker {
	if opts.Poll <= 0 {
		opts.Poll = DefaultPoll
	}
	if opts.Batch <= 0 {
		opts.Batch = DefaultBatch
	}
	if opts.IntegrityEvery <= 0 {
		opts.IntegrityEvery = DefaultIntegrityEvery
	}
	return &Worker{core: c, opts: opts}
}

// Run processes due accounts every Poll until ctx is done. Idle cost: three index probes on
// the partial indexes of due / stopped / deadline accounts per tick.
func (w *Worker) Run(ctx context.Context) {
	t := time.NewTicker(w.opts.Poll)
	defer t.Stop()
	for {
		w.Tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Tick runs one round: up to Batch accounts of every kind. Returns how many were processed.
func (w *Worker) Tick(ctx context.Context) int {
	kinds := []string{core.DueRenewal, core.DueCoverage}
	if w.opts.Suspend {
		kinds = append(kinds, core.DueSuspension)
	}
	total := 0
	for _, kind := range kinds {
		total += w.round(ctx, kind)
	}
	return total
}

func (w *Worker) round(ctx context.Context, kind string) int {
	skip := []uuid.UUID{}
	n := 0
	for i := 0; i < w.opts.Batch && ctx.Err() == nil; i++ {
		id, ok, more, err := w.core.ProcessDue(ctx, kind, skip)
		if err != nil {
			if ctx.Err() != nil {
				return n
			}
			processed.WithLabelValues(kind, "error").Inc()
			slog.ErrorContext(ctx, "billing: due account failed", "kind", kind, "account", id, "err", err)
			if id == uuid.Nil {
				return n // the claim itself failed: try again next tick
			}
			skip = append(skip, id)
			continue
		}
		if !ok {
			return n
		}
		n++
		processed.WithLabelValues(kind, "ok").Inc()
		if !more {
			skip = append(skip, id) // done for this round even if its next boundary is due again
		}
	}
	return n
}

// RunIntegrity checks the ledger once at start and then every IntegrityEvery until ctx is
// done; mismatches are logged as errors and exported as a gauge (no repair).
func (w *Worker) RunIntegrity(ctx context.Context) {
	t := time.NewTicker(w.opts.IntegrityEvery)
	defer t.Stop()
	for {
		w.CheckIntegrity(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// CheckIntegrity runs the check once and returns the mismatches (nil on a query error, which
// is logged).
func (w *Worker) CheckIntegrity(ctx context.Context) []core.Mismatch {
	ms, err := w.core.CheckIntegrity(ctx)
	if err != nil {
		if ctx.Err() == nil {
			slog.ErrorContext(ctx, "billing: integrity check failed", "err", err)
		}
		return nil
	}
	counts := map[string]int{core.CheckLedger: 0, core.CheckFunding: 0}
	for _, m := range ms {
		counts[m.Check]++
		slog.ErrorContext(ctx, "billing: integrity mismatch", "check", m.Check, "account", m.AccountID,
			"balance", m.Balance, "expected", m.Expected, "entry_seq", m.EntrySeq, "ledger_seq", m.LedgerSeq)
	}
	for check, n := range counts {
		mismatches.WithLabelValues(check).Set(float64(n))
	}
	return ms
}
