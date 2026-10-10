package inbox

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// AccountImportWindow is how far back a superadmin reconcile of one account lists payments.
const AccountImportWindow = 30 * 24 * time.Hour

// refundRetryAfter: a Calab refund untouched for this long is asked again (same key).
const refundRetryAfter = 10 * time.Minute

// ReconcileAccount re-reads one account's provider objects and applies what is missing
// (admin.Reconciler, POST /api/admin/billing/accounts/{id}/reconcile): open checkouts,
// processing payments, the customer's payments of the last 30 days, and Calab refunds still
// waiting for the provider. The first error is returned after every step ran.
func (in *Inbox) ReconcileAccount(ctx context.Context, accountID uuid.UUID) error {
	var errs []error
	cos, err := in.db.Q.ListBillingOpenCheckoutsOfAccount(ctx, accountID)
	errs = append(errs, err)
	for _, co := range cos {
		_, err := in.SyncCheckout(ctx, co, "reconcile")
		errs = append(errs, err)
	}
	pays, err := in.db.Q.ListBillingPaymentsProcessingOfAccount(ctx, accountID)
	errs = append(errs, err)
	for _, pay := range pays {
		if p, ok := in.reg.Provider(provider.ID(pay.Provider)); ok {
			_, err := in.SyncPayment(ctx, p, pay.ProviderPaymentID, "reconcile")
			errs = append(errs, err)
		}
	}
	custs, err := in.db.Q.ListBillingCustomersOfAccount(ctx, accountID)
	errs = append(errs, err)
	for _, c := range custs {
		p, ok := in.reg.Provider(provider.ID(c.Provider))
		if !ok || !p.Caps().Has(provider.CapListPayments) {
			continue
		}
		errs = append(errs, in.importCustomer(ctx, p, c, time.Now().Add(-AccountImportWindow)))
	}
	errs = append(errs, in.retryRefunds(ctx, &accountID, time.Now()))
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}

// retryRefunds asks the provider again for Calab refunds still pending: without a provider id
// Refund with the same idempotency key (a lost answer returns the same refund) while inside
// core.RefundRepostWindow, then only a lookup; with one a fresh read. account nil = every
// account (and the needs-review gauge is refreshed).
func (in *Inbox) retryRefunds(ctx context.Context, account *uuid.UUID, before time.Time) error {
	refs, err := in.db.Q.ListBillingRefundsToRetry(ctx, sqlc.ListBillingRefundsToRetryParams{AccountID: account, Before: before, Lim: reconcileBatch})
	if err != nil {
		return err
	}
	if account == nil {
		defer func() {
			if n, err := in.db.Q.CountBillingRefundsNeedingReview(ctx); err == nil {
				refundsNeedingReview.Set(float64(n))
			}
		}()
	}
	var first error
	for _, ref := range refs {
		if err := in.RetryRefund(ctx, ref); err != nil {
			slog.WarnContext(ctx, "billing reconcile: refund", "refund", ref.ID, "err", err)
			if first == nil {
				first = err
			}
		}
	}
	return first
}

// RetryRefund finishes one pending Calab refund through the provider (same Idempotency-Key as
// the first call: billing_refunds.idem_key). An unknown outcome leaves it pending; a definite
// refusal to create it fails it (the reservation goes back to the balance). Past
// core.RefundRepostWindow it is never POSTed again (an expired key could refund twice): the
// payment's refunds are listed and matched by metadata calab_refund_id; nothing found after
// core.RefundReviewAfter marks it needs_review (lookupRefund).
func (in *Inbox) RetryRefund(ctx context.Context, ref sqlc.BillingRefund) error {
	if ref.Origin != core.RefundOriginCalab || (ref.Status != core.RefundPending && ref.Status != core.RefundRequiresAction) {
		return nil
	}
	pay, err := in.db.Q.GetBillingPayment(ctx, ref.PaymentID)
	if err != nil {
		return err
	}
	p, ok := in.reg.Provider(provider.ID(pay.Provider))
	if !ok {
		return fmt.Errorf("billing reconcile: provider %q is not configured", pay.Provider)
	}
	var fact provider.RefundFact
	if ref.ProviderRefundID != nil {
		fact, err = p.GetRefund(ctx, *ref.ProviderRefundID)
		if err != nil {
			return err
		}
		return in.ApplyRefund(ctx, p, fact)
	}
	if !core.RefundMayRepost(ref) || (!p.Caps().SafeRetry() && ref.DispatchedAt != nil) {
		// Past the idempotency window, or sent once to a provider without idempotency keys
		// (ADR-0083): only read, never send again.
		_, err := in.lookupRefund(ctx, p, pay, ref)
		return err
	}
	if !p.Caps().SafeRetry() {
		sent, err := in.core.MarkRefundDispatched(ctx, ref.ID)
		if err != nil || !sent {
			return err
		}
	}
	fact, err = p.Refund(ctx, provider.RefundReq{
		IdemKey: ref.IdemKey, PaymentID: pay.ProviderPaymentID, Amount: money.New(ref.AmountMinor, money.Currency(ref.Currency)),
		Reason: ref.Reason, Metadata: provider.Metadata{AccountID: ref.AccountID, RefundID: ref.ID},
	})
	status := ""
	switch {
	case errors.Is(err, provider.ErrNotSupported):
		slog.ErrorContext(ctx, "billing reconcile: refund needs a manual refund in the provider's interface", "refund", ref.ID, "err", err)
		if marked, merr := in.core.MarkRefundNeedsReview(ctx, ref); merr != nil {
			return merr
		} else if marked {
			refundsMarkedForReview.Inc()
		}
		return nil
	case errors.Is(err, provider.ErrUnknownOutcome):
		return err
	case err != nil:
		slog.WarnContext(ctx, "billing reconcile: provider refused the refund", "refund", ref.ID, "err", err)
		status = core.RefundFailed
	case fact.PaymentID != pay.ProviderPaymentID || fact.Amount.Minor != ref.AmountMinor || string(fact.Amount.Currency) != ref.Currency:
		return permanent("refund %s: provider refund %s does not match: %w", ref.ID, fact.ID, ErrMismatch)
	default:
		status = refundStatus(fact.Status)
	}
	return in.settleRefund(ctx, ref, status, fact.ID)
}

// settleRefund records the provider's answer for a Calab refund (provider id when pending).
func (in *Inbox) settleRefund(ctx context.Context, ref sqlc.BillingRefund, status, providerID string) error {
	var pid *string
	if providerID != "" {
		pid = &providerID
	}
	var acc sqlc.BillingAccount
	changed := false
	err := in.db.Tx(ctx, func(q *sqlc.Queries) error {
		var err error
		if acc, err = q.LockBillingAccount(ctx, ref.AccountID); err != nil {
			return err
		}
		if status == core.RefundPending {
			if pid == nil {
				return nil
			}
			_, err := q.AdminSetBillingRefundProviderID(ctx, sqlc.AdminSetBillingRefundProviderIDParams{ProviderRefundID: *pid, Now: time.Now(), ID: ref.ID})
			if db.IsNotFound(err) {
				return nil
			}
			return err
		}
		changed = true
		_, acc, err = in.core.ApplyRefundResult(ctx, q, ref.ID, status, pid)
		return err
	})
	if err == nil && changed {
		in.committed(ctx, acc)
	}
	return err
}

var (
	refundsMarkedForReview = promauto.NewCounter(prometheus.CounterOpts{
		Name: "calaba_billing_refunds_marked_needs_review_total",
		Help: "Calab refunds with no trace at the provider 24 h after they were written (money stays reserved; a superadmin resolves). Alert on any increase.",
	})
	refundsNeedingReview = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "calaba_billing_refunds_needs_review",
		Help: "Calab refunds marked needs_review and not resolved yet (refreshed by the reconciliation pass).",
	})
)

// findRefund lists the refunds of the payment at the provider and returns the one created for
// ref (metadata calab_refund_id), and whether the provider has a refund of ref's amount that no
// local row knows (a refund made by hand, or one created before the metadata existed).
func (in *Inbox) findRefund(ctx context.Context, p provider.Provider, pay sqlc.BillingPayment, ref sqlc.BillingRefund) (f provider.RefundFact, found, unclaimed bool, err error) {
	l, ok := p.(provider.RefundLister)
	if !ok {
		return f, false, false, fmt.Errorf("billing reconcile: provider %s cannot list refunds", p.ID())
	}
	facts, err := l.ListRefunds(ctx, pay.ProviderPaymentID)
	if err != nil {
		return f, false, false, err
	}
	for _, x := range facts {
		if x.Metadata.RefundID == ref.ID {
			return x, true, false, nil
		}
		if x.Amount.Minor != ref.AmountMinor || x.Status == provider.RefundFailed || x.Status == provider.RefundCanceled {
			continue
		}
		if _, err := in.db.Q.GetBillingRefundByProviderID(ctx, &x.ID); db.IsNotFound(err) {
			unclaimed = true
		} else if err != nil {
			return f, false, false, err
		}
	}
	return f, false, unclaimed, nil
}

// lookupRefund resolves a Calab refund past the repost window by listing, never by POSTing:
// found → its status is applied; nothing after core.RefundReviewAfter → needs_review (error
// log + metric), the reservation stays. resolved = the provider's refund was found.
func (in *Inbox) lookupRefund(ctx context.Context, p provider.Provider, pay sqlc.BillingPayment, ref sqlc.BillingRefund) (bool, error) {
	if !p.Caps().SafeRetry() {
		// No metadata at the provider (Tochka): apply every refund of the payment — one not
		// known by id is matched to a pending Calab refund of the same amount (ApplyRefund),
		// a refund made by hand in the bank for a needs-review row included.
		if done, err := in.applyListedRefunds(ctx, p, pay, ref); err != nil || done {
			return done, err
		}
		if time.Since(ref.CreatedAt) < core.RefundReviewAfter || ref.NeedsReviewAt != nil {
			return false, nil
		}
		marked, err := in.core.MarkRefundNeedsReview(ctx, ref)
		if marked {
			refundsMarkedForReview.Inc()
			slog.ErrorContext(ctx, "billing: refund not visible at the provider 24 h after it was sent; money stays reserved, superadmin review needed",
				"refund", ref.ID, "account", ref.AccountID, "payment", pay.ProviderPaymentID, "amount_minor", ref.AmountMinor)
		}
		return false, err
	}
	f, found, _, err := in.findRefund(ctx, p, pay, ref)
	if err != nil {
		return false, err
	}
	if found {
		if f.PaymentID != pay.ProviderPaymentID || f.Amount.Minor != ref.AmountMinor || string(f.Amount.Currency) != ref.Currency {
			return false, permanent("refund %s: provider refund %s does not match: %w", ref.ID, f.ID, ErrMismatch)
		}
		return true, in.ApplyRefund(ctx, p, f)
	}
	if time.Since(ref.CreatedAt) < core.RefundReviewAfter || ref.NeedsReviewAt != nil {
		return false, nil
	}
	var marked bool
	err = in.db.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockBillingAccount(ctx, ref.AccountID); err != nil {
			return err
		}
		_, err := q.MarkBillingRefundNeedsReview(ctx, sqlc.MarkBillingRefundNeedsReviewParams{Now: time.Now().UTC(), ID: ref.ID})
		if db.IsNotFound(err) {
			return nil
		}
		marked = err == nil
		return err
	})
	if marked {
		refundsMarkedForReview.Inc()
		slog.ErrorContext(ctx, "billing: refund outcome unknown past the idempotency window and not found at the provider; money stays reserved, superadmin review needed",
			"refund", ref.ID, "account", ref.AccountID, "payment", pay.ProviderPaymentID, "amount_minor", ref.AmountMinor)
	}
	return false, err
}

// applyListedRefunds applies the payment's refunds listed by the provider and reports whether
// ref now has its provider refund.
func (in *Inbox) applyListedRefunds(ctx context.Context, p provider.Provider, pay sqlc.BillingPayment, ref sqlc.BillingRefund) (bool, error) {
	l, ok := p.(provider.RefundLister)
	if !ok {
		return false, fmt.Errorf("billing reconcile: provider %s cannot list refunds", p.ID())
	}
	facts, err := l.ListRefunds(ctx, pay.ProviderPaymentID)
	if err != nil {
		return false, err
	}
	for _, f := range facts {
		if err := in.ApplyRefund(ctx, p, f); err != nil {
			return false, err
		}
	}
	cur, err := in.db.Q.GetBillingRefund(ctx, ref.ID)
	if err != nil {
		return false, err
	}
	return cur.ProviderRefundID != nil, nil
}

// ReleaseRefund resolves a needs-review Calab refund the superadmin confirmed absent at the
// provider (admin reconcile with release_refund_ids): one more lookup; if the provider has it
// after all it is applied, if the provider has a refund of that amount no row claims it the
// release is refused (billing.ErrRefundNotReleasable: let the webhook / reconcile match it),
// else it fails and its reservation returns to the balance.
func (in *Inbox) ReleaseRefund(ctx context.Context, accountID, refundID uuid.UUID) error {
	ref, err := in.db.Q.GetBillingRefund(ctx, refundID)
	if db.IsNotFound(err) || err == nil && ref.AccountID != accountID {
		return billing.ErrRefundNotReleasable
	}
	if err != nil {
		return err
	}
	if ref.Origin != core.RefundOriginCalab || ref.NeedsReviewAt == nil || ref.ProviderRefundID != nil ||
		(ref.Status != core.RefundPending && ref.Status != core.RefundRequiresAction) {
		return billing.ErrRefundNotReleasable
	}
	pay, err := in.db.Q.GetBillingPayment(ctx, ref.PaymentID)
	if err != nil {
		return err
	}
	p, ok := in.reg.Provider(provider.ID(pay.Provider))
	if !ok {
		return billing.ErrProviderUnavailable
	}
	f, found, unclaimed, err := in.findRefund(ctx, p, pay, ref)
	if err != nil {
		return err
	}
	if found {
		return in.ApplyRefund(ctx, p, f)
	}
	if unclaimed {
		return billing.ErrRefundNotReleasable
	}
	slog.WarnContext(ctx, "billing: needs-review refund released by a superadmin", "refund", ref.ID, "account", ref.AccountID)
	return in.settleRefund(ctx, ref, core.RefundFailed, "")
}
