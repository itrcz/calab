package inbox

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

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
// Refund with the same idempotency key (a lost answer returns the same refund), with one a
// fresh read. account nil = every account.
func (in *Inbox) retryRefunds(ctx context.Context, account *uuid.UUID, before time.Time) error {
	refs, err := in.db.Q.ListBillingRefundsToRetry(ctx, sqlc.ListBillingRefundsToRetryParams{AccountID: account, Before: before, Lim: reconcileBatch})
	if err != nil {
		return err
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
// refusal to create it fails it (the reservation goes back to the balance).
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
	fact, err = p.Refund(ctx, provider.RefundReq{
		IdemKey: ref.IdemKey, PaymentID: pay.ProviderPaymentID, Amount: money.New(ref.AmountMinor, money.Currency(ref.Currency)),
		Reason: ref.Reason, Metadata: provider.Metadata{AccountID: ref.AccountID},
	})
	status := ""
	switch {
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
