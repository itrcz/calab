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
	if err := j.recheck(ctx, now); err != nil && first == nil {
		first = err
	}
	return first
}

// recheck reads again, at most every RecheckEvery, the charges of the methods of reconcilable
// attempts that failed within ReconcileGiveUp («declined», not_found, refused after the send):
// the bank's answer never identifies the payment, so an approval that appears late is credited
// to its attempt (failed → succeeded, one credit per charge) instead of waiting for the next
// charge of the card (snapshot) or an operator.
func (j *Job) recheck(ctx context.Context, now time.Time) error {
	j.mu.Lock()
	due := !now.Before(j.recheckAt)
	if due {
		j.recheckAt = now.Add(RecheckEvery)
	}
	j.mu.Unlock()
	if !due {
		return nil
	}
	atts, err := j.db.Q.ListBillingReconcilableAttemptsToRecheck(ctx, sqlc.ListBillingReconcilableAttemptsToRecheckParams{
		Since: now.Add(-j.opts.ReconcileGiveUp), Lim: recoverBatch,
	})
	if err != nil {
		return err
	}
	var errs []error
	for _, att := range atts {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		errs = append(errs, j.recheckOne(ctx, att))
	}
	return errors.Join(errs...)
}

func (j *Job) recheckOne(ctx context.Context, att sqlc.BillingAutotopupAttempt) error {
	t, err := j.targetOf(ctx, att)
	if err != nil || !t.reconcilable() {
		return err
	}
	f, found, err := j.findCharge(ctx, t, att)
	if err != nil || !found {
		return err
	}
	// Read after the list: with no charge of the account in flight now, none was sent before the
	// list was read without being closed, so the charge found is not an open attempt's.
	if _, err := j.db.Q.GetOpenBillingAutoTopupAttempt(ctx, att.AccountID); err == nil {
		return nil
	} else if !db.IsNotFound(err) {
		return err
	}
	slog.ErrorContext(ctx, "billing auto-topup: a failed charge appeared late in the method's charges, crediting it",
		"attempt", att.ID, "account", att.AccountID, "failure_code", att.FailureCode)
	return j.credit(ctx, t, att, f)
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
	since := att.CreatedAt
	if att.DispatchedAt != nil {
		since = *att.DispatchedAt
	}
	age := now.Sub(since)
	if t.reconcilable() {
		return j.resolveReconcilable(ctx, t, att, max(age, time.Since(att.CreatedAt)))
	}
	if att.ProviderPaymentID != nil {
		f, err := t.p.GetPayment(ctx, *att.ProviderPaymentID)
		if err != nil {
			return false, err
		}
		if f.Status == provider.PaymentRequiresAction && att.Kind == KindManual && max(age, time.Since(att.CreatedAt)) >= j.opts.ActionTimeout {
			// The owner did not confirm 3-D Secure: cancel the intent, the charge failed.
			cf, err := t.charger.CancelPayment(ctx, f.ID)
			if err != nil {
				return false, err
			}
			if cf.Status == provider.PaymentRequiresAction {
				return false, nil
			}
			if cf.Status == provider.PaymentCanceled {
				cf.FailureCode = CodeAuthRequired
			}
			return cf.Status != provider.PaymentProcessing, j.settle(ctx, t, att, cf)
		}
		waiting := f.Status == provider.PaymentProcessing || (f.Status == provider.PaymentRequiresAction && att.Kind == KindManual)
		return !waiting, j.settle(ctx, t, att, f)
	}
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
		f, err := t.charger.ChargeOffSession(cctx, j.request(att, t))
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

// resolveReconcilable resolves an open charge of a provider without idempotency keys by reading
// the method's charges only (ADR-0083): found → credited; nothing after GiveUpAfter → logged as
// an error on every pass (an operator compares with the bank); nothing after ReconcileGiveUp →
// failed not_found. The attempt stays open meanwhile, so no other charge of the account starts.
func (j *Job) resolveReconcilable(ctx context.Context, t target, att sqlc.BillingAutotopupAttempt, age time.Duration) (bool, error) {
	f, found, err := j.findCharge(ctx, t, att)
	if err != nil {
		return false, err
	}
	if found {
		return true, j.credit(ctx, t, att, f)
	}
	switch {
	case age >= j.opts.ReconcileGiveUp:
		slog.ErrorContext(ctx, "billing auto-topup: charge never appeared in the method's charges, closing it",
			"attempt", att.ID, "account", att.AccountID, "kind", att.Kind)
		attempts.WithLabelValues(CodeNotFound).Inc()
		return true, j.fail(ctx, att, nil, CodeNotFound, "")
	case age >= j.opts.GiveUpAfter:
		slog.ErrorContext(ctx, "billing auto-topup: charge outcome still unknown, check the bank (no retry is ever sent)",
			"attempt", att.ID, "account", att.AccountID, "kind", att.Kind, "status", att.Status)
	}
	return false, nil
}

// mayRetry: a same-key retry is allowed only inside RetryWindow, with auto-topup on and not
// paused, the consent still live on the attempt's card and the account active. Otherwise only
// lookups: a revoked consent never gets a charge it did not already get. A one-click charge is
// retried while its card is still attached and the account active.
func (j *Job) mayRetry(ctx context.Context, att sqlc.BillingAutotopupAttempt, age time.Duration) (bool, error) {
	if age >= j.opts.RetryWindow {
		return false, nil
	}
	if att.Kind == KindManual {
		acc, err := j.db.Q.GetBillingAccount(ctx, att.AccountID)
		if err != nil {
			return false, err
		}
		v, err := j.checkManual(ctx, j.db.Q, acc, att.PmID)
		return err == nil && v.ok(), err
	}
	if !j.opts.Enabled {
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
	kind := provider.MetadataKindAutoTopup
	if att.Kind == KindManual {
		kind = provider.MetadataKindSavedMethod
	}
	cursor := ""
	for range 10 {
		facts, next, err := t.p.ListPayments(ctx, provider.ListReq{
			Customer: t.ref(), CreatedAfter: att.CreatedAt.Add(-time.Hour), Kind: kind, Cursor: cursor, Limit: 100,
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
