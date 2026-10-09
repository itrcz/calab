package autotopup

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// recoverBatch bounds the open attempts one pass looks at.
const recoverBatch = 100

// Recover resolves the open attempts older than Grace (see the package doc). Errors are logged
// per attempt; the first one is returned.
func (j *Job) Recover(ctx context.Context) error {
	now, err := j.clock.Now(ctx, j.db.Q)
	if err != nil {
		return err
	}
	atts, err := j.db.Q.ListBillingAutoTopupAttemptsToRecover(ctx, sqlc.ListBillingAutoTopupAttemptsToRecoverParams{
		Before: now.Add(-j.opts.Grace), Lim: recoverBatch,
	})
	if err != nil {
		return err
	}
	var first error
	for _, att := range atts {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !j.due(att.ID, now) {
			continue
		}
		done, err := j.resolve(ctx, att, now)
		j.after(att.ID, now, done)
		if err != nil {
			slog.WarnContext(ctx, "billing auto-topup: resolve attempt", "attempt", att.ID, "status", att.Status, "err", err)
			if first == nil {
				first = err
			}
		}
	}
	return first
}

// due: the attempt's backoff has passed.
func (j *Job) due(id uuid.UUID, now time.Time) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	r, ok := j.retry[id]
	return !ok || !now.Before(r.next)
}

// after records a resolution pass: done forgets the attempt, else the next pass waits 1 min
// doubling up to 30 min.
func (j *Job) after(id uuid.UUID, now time.Time, done bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if done {
		delete(j.retry, id)
		return
	}
	r := j.retry[id]
	r.next = now.Add(min(time.Minute<<min(r.n, 5), 30*time.Minute))
	r.n++
	j.retry[id] = r
}

// resolve tries to finish one open attempt. done = it is final now.
func (j *Job) resolve(ctx context.Context, att sqlc.BillingAutotopupAttempt, now time.Time) (bool, error) {
	if att.Status == statusPrepared {
		// The fence commits dispatched before the provider call: a prepared attempt was never
		// sent (crash between prepare and fence).
		err := j.db.Tx(ctx, func(q *sqlc.Queries) error {
			if _, err := q.LockBillingAccount(ctx, att.AccountID); err != nil {
				return err
			}
			_, err := q.FailBillingAutoTopupAttemptPrepared(ctx, sqlc.FailBillingAutoTopupAttemptPreparedParams{FailureCode: CodeAbandoned, Now: now, ID: att.ID})
			if db.IsNotFound(err) {
				return nil // the fence moved it meanwhile
			}
			if err == nil {
				attempts.WithLabelValues(CodeAbandoned).Inc()
			}
			return err
		})
		return err == nil, err
	}
	t, err := j.targetOf(ctx, att)
	if err != nil {
		return false, err
	}
	if att.ProviderPaymentID != nil {
		f, err := t.p.GetPayment(ctx, *att.ProviderPaymentID)
		if err != nil {
			return false, err
		}
		return f.Status != provider.PaymentProcessing, j.settle(ctx, t, att, f)
	}
	since := att.CreatedAt
	if att.DispatchedAt != nil {
		since = *att.DispatchedAt
	}
	age := now.Sub(since)
	// The provider's idempotency window runs on the wall clock: the same-key retry also stops
	// by the wall age of the row (created_at = database now(), before the dispatch), so a
	// billing clock behind real time can never re-POST with an expired key.
	retry, err := j.mayRetry(ctx, att, max(age, time.Since(att.CreatedAt)))
	if err != nil {
		return false, err
	}
	if retry {
		// Same Idempotency-Key, same request: the provider answers with the first payment
		// (or creates the one the lost request never created).
		cctx, cancel := context.WithTimeout(ctx, j.opts.ChargeTimeout)
		f, err := t.charger.ChargeOffSession(cctx, request(att, t))
		cancel()
		if err != nil {
			return false, j.outcome(ctx, t, att, f, err, true)
		}
		return f.Status != provider.PaymentProcessing, j.outcome(ctx, t, att, f, nil, true)
	}
	f, found, err := j.lookup(ctx, t, att)
	if err != nil {
		return false, err
	}
	if found {
		return f.Status != provider.PaymentProcessing, j.settle(ctx, t, att, f)
	}
	if age >= j.opts.GiveUpAfter {
		// Past the idempotency window and the provider has no payment of this attempt: it was
		// never created. Not a decline: no owner mail.
		slog.ErrorContext(ctx, "billing auto-topup: unknown attempt has no payment, closing it", "attempt", att.ID, "account", att.AccountID)
		attempts.WithLabelValues(CodeNotFound).Inc()
		return true, j.fail(ctx, att, nil, CodeNotFound, "")
	}
	return false, nil
}

// mayRetry: a same-key retry is allowed only inside RetryWindow, with auto-topup on and not
// paused, the consent still live on the attempt's card and the account active. Otherwise only
// lookups: a revoked consent never gets a charge it did not already get.
func (j *Job) mayRetry(ctx context.Context, att sqlc.BillingAutotopupAttempt, age time.Duration) (bool, error) {
	if !j.opts.Enabled || age >= j.opts.RetryWindow {
		return false, nil
	}
	if paused, err := j.Paused(ctx); err != nil || paused {
		return false, err
	}
	c, err := j.db.Q.GetBillingAutoTopup(ctx, att.AccountID)
	if db.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	acc, err := j.db.Q.GetBillingAccount(ctx, att.AccountID)
	if err != nil {
		return false, err
	}
	return c.RevokedAt == nil && c.PmID == att.PmID && acc.Status == "active", nil
}

// lookup finds the payment of an attempt at the provider: auto-topup payments of the customer
// created since an hour before the attempt, matched by metadata attempt id.
func (j *Job) lookup(ctx context.Context, t target, att sqlc.BillingAutotopupAttempt) (provider.PaymentFact, bool, error) {
	if !t.p.Caps().Has(provider.CapListPayments) {
		return provider.PaymentFact{}, false, errors.New("auto-topup: provider cannot list payments")
	}
	cursor := ""
	for range 10 {
		facts, next, err := t.p.ListPayments(ctx, provider.ListReq{
			Customer: t.ref(), CreatedAfter: att.CreatedAt.Add(-time.Hour), Kind: provider.MetadataKindAutoTopup, Cursor: cursor, Limit: 100,
		})
		if err != nil {
			return provider.PaymentFact{}, false, err
		}
		for _, f := range facts {
			if f.Metadata.AttemptID == att.ID {
				return f, true, nil
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	return provider.PaymentFact{}, false, nil
}
