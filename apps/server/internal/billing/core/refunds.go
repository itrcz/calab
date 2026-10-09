package core

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Refund statuses and origins (billing_refunds).
const (
	RefundPending        = "pending"
	RefundRequiresAction = "requires_action"
	RefundSucceeded      = "succeeded"
	RefundFailed         = "failed"
	RefundCanceled       = "canceled"

	RefundOriginCalab     = "calab"     // requested through Calab (admin): unused money only
	RefundOriginDashboard = "dashboard" // already made in the provider dashboard: recorded as it is
)

// Unknown-outcome rules of a Calab refund (wall clock, from billing_refunds.created_at — the
// database now() of the reservation, never later than the first provider call). Stripe keeps an
// Idempotency-Key for 24 h; a POST with an expired key would create a second refund.
const (
	// RefundRepostWindow: a refund without a provider id is POSTed again (same key) only while
	// younger than this; afterwards it is only looked up (the payment's refunds, metadata
	// calab_refund_id).
	RefundRepostWindow = 23 * time.Hour
	// RefundReviewAfter: a refund the provider has no trace of this long after it was written
	// is marked needs_review; its money stays reserved until a superadmin resolves it.
	RefundReviewAfter = 24 * time.Hour
)

// RefundMayRepost reports whether a Calab refund without a provider id may be sent again with
// its idempotency key.
func RefundMayRepost(ref sqlc.BillingRefund) bool {
	return ref.NeedsReviewAt == nil && time.Since(ref.CreatedAt) < RefundRepostWindow
}

// Refundable is what can go back to one payment now.
type Refundable struct {
	Minor       int64  // unused money of the payment's funding lot
	Currency    string // of the account
	DisputeHold bool   // an open dispute: no refunds now (billing.ErrDisputeHold)
}

// RefundableForPayment returns the unused part of the payment's own funding lot. Money already spent
// on delivered service is not refundable; cancelling unused seat-days first (CancelSeats)
// gives their money back to their lots, which raises this. Admin credit is never refundable.
func (c *Core) RefundableForPayment(ctx context.Context, q *sqlc.Queries, paymentID uuid.UUID) (Refundable, error) {
	pay, err := q.GetBillingPayment(ctx, paymentID)
	if err != nil {
		return Refundable{}, err
	}
	acc, err := q.GetBillingAccount(ctx, pay.AccountID)
	if err != nil {
		return Refundable{}, err
	}
	r := Refundable{Currency: acc.Currency, DisputeHold: acc.DisputeHold}
	lot, err := q.GetBillingFundingLotByPayment(ctx, &pay.ID)
	if db.IsNotFound(err) {
		return r, nil
	}
	if err != nil {
		return Refundable{}, err
	}
	r.Minor = lotFree(lot)
	return r, nil
}

// RefundReq reserves a refund of one payment.
type RefundReq struct {
	PaymentID uuid.UUID
	Amount    int64
	// IdemKey is billing_refunds.idem_key and the provider Idempotency-Key: 'refund:{request}'
	// for Calab refunds, 'dashboard:{provider_refund_id}' for refunds made in the dashboard.
	IdemKey string
	Origin  string // RefundOriginCalab | RefundOriginDashboard
	// Status of a dashboard refund as the provider reports it (else pending).
	Status           string
	ProviderRefundID *string
	Reason           string
	RequestedBy      *uuid.UUID
}

// ReserveRefund records a refund and takes its amount off the balance at once (the daily job
// cannot spend it), in the caller's transaction (T5 / T6; no provider call inside). A Calab
// refund takes only the unused money of the payment's lot (billing.ErrRefundExceedsRefundable)
// and is refused under a dispute (billing.ErrDisputeHold). A dashboard refund already happened
// at the provider: it is recorded as it is, the spent part of the lot becomes debt again. The
// same IdemKey returns the existing refund (another payment / amount → billing.ErrRequestReused).
// Then call the provider with IdemKey and ApplyRefundResult with its answer.
func (c *Core) ReserveRefund(ctx context.Context, q *sqlc.Queries, r RefundReq) (sqlc.BillingRefund, sqlc.BillingAccount, error) {
	if err := positive(r.Amount); err != nil {
		return sqlc.BillingRefund{}, sqlc.BillingAccount{}, err
	}
	if r.Origin != RefundOriginCalab && r.Origin != RefundOriginDashboard {
		return sqlc.BillingRefund{}, sqlc.BillingAccount{}, httpx.Validation("origin", "origin must be calab or dashboard")
	}
	pay, err := q.GetBillingPayment(ctx, r.PaymentID)
	if err != nil {
		return sqlc.BillingRefund{}, sqlc.BillingAccount{}, err
	}
	s, err := c.lock(ctx, q, pay.AccountID, r.RequestedBy)
	if err != nil {
		return sqlc.BillingRefund{}, sqlc.BillingAccount{}, err
	}
	if old, err := q.GetBillingRefundByIdemKey(ctx, r.IdemKey); err == nil {
		if old.PaymentID != pay.ID || old.AmountMinor != r.Amount {
			return old, s.acc, billing.ErrRequestReused
		}
		return old, s.acc, nil
	} else if !db.IsNotFound(err) {
		return sqlc.BillingRefund{}, sqlc.BillingAccount{}, err
	}
	lot, err := q.LockBillingFundingLotByPayment(ctx, &pay.ID)
	if db.IsNotFound(err) {
		return sqlc.BillingRefund{}, s.acc, billing.ErrRefundExceedsRefundable
	}
	if err != nil {
		return sqlc.BillingRefund{}, sqlc.BillingAccount{}, err
	}
	status := RefundPending
	if r.Origin == RefundOriginCalab {
		if s.acc.DisputeHold {
			return sqlc.BillingRefund{}, s.acc, billing.ErrDisputeHold
		}
		if r.Amount > lotFree(lot) {
			return sqlc.BillingRefund{}, s.acc, billing.ErrRefundExceedsRefundable
		}
	} else if r.Amount > lot.AmountMinor-lot.RefundedMinor {
		return sqlc.BillingRefund{}, s.acc, billing.ErrRefundExceedsRefundable
	}
	ref, err := q.InsertBillingRefund(ctx, sqlc.InsertBillingRefundParams{
		AccountID: s.acc.ID, PaymentID: pay.ID, LotID: &lot.ID, AmountMinor: r.Amount, Currency: s.acc.Currency,
		Status: status, Origin: r.Origin, ProviderRefundID: r.ProviderRefundID, IdemKey: r.IdemKey, Reason: r.Reason,
		RequestedBy: r.RequestedBy,
	})
	if db.IsNotFound(err) {
		return ref, s.acc, billing.ErrRequestReused // provider_refund_id recorded under another key
	}
	if err != nil {
		return ref, s.acc, err
	}
	taken, err := s.clawback(lot, r.Amount)
	if err != nil {
		return ref, s.acc, err
	}
	if err := s.append(KindRefund, -taken, "refund:"+ref.ID.String(), refs{lot: &lot.ID, refund: &ref.ID}, r.Reason); err != nil {
		return ref, s.acc, err
	}
	if err := s.afterTakeback(); err != nil {
		return ref, s.acc, err
	}
	if err := s.save(); err != nil {
		return ref, s.acc, err
	}
	if r.Status != "" && r.Status != RefundPending {
		return c.applyRefund(s, ref, r.Status, r.ProviderRefundID)
	}
	return ref, s.acc, nil
}

// ApplyRefundResult records the provider's answer in the caller's transaction: succeeded →
// final (the payment's refunded amount grows); failed / canceled → the reservation goes back
// to the balance (and pays debts first); requires_action → only the status. A final refund is
// not changed again (replay).
func (c *Core) ApplyRefundResult(ctx context.Context, q *sqlc.Queries, refundID uuid.UUID, status string, providerRefundID *string) (sqlc.BillingRefund, sqlc.BillingAccount, error) {
	switch status {
	case RefundSucceeded, RefundFailed, RefundCanceled, RefundRequiresAction:
	default:
		return sqlc.BillingRefund{}, sqlc.BillingAccount{}, httpx.Validation("status", "unknown refund status")
	}
	ref0, err := q.GetBillingRefund(ctx, refundID)
	if err != nil {
		return sqlc.BillingRefund{}, sqlc.BillingAccount{}, err
	}
	s, err := c.lock(ctx, q, ref0.AccountID, nil)
	if err != nil {
		return sqlc.BillingRefund{}, sqlc.BillingAccount{}, err
	}
	ref, err := q.LockBillingRefund(ctx, refundID)
	if err != nil {
		return ref, s.acc, err
	}
	return c.applyRefund(s, ref, status, providerRefundID)
}

func (c *Core) applyRefund(s *state, ref sqlc.BillingRefund, status string, providerRefundID *string) (sqlc.BillingRefund, sqlc.BillingAccount, error) {
	if ref.Status != RefundPending && ref.Status != RefundRequiresAction {
		return ref, s.acc, nil
	}
	ref, err := s.q.SetBillingRefundStatus(s.ctx, sqlc.SetBillingRefundStatusParams{
		Status: status, ProviderRefundID: providerRefundID, Now: s.now, ID: ref.ID,
	})
	if err != nil {
		return ref, s.acc, err
	}
	switch status {
	case RefundSucceeded:
		if _, err := s.q.AddBillingPaymentRefunded(s.ctx, sqlc.AddBillingPaymentRefundedParams{Delta: ref.AmountMinor, Now: s.now, ID: ref.PaymentID}); err != nil {
			return ref, s.acc, err
		}
	case RefundFailed, RefundCanceled:
		e, err := s.q.GetBillingLedgerEntryByKey(s.ctx, "refund:"+ref.ID.String())
		if err != nil {
			return ref, s.acc, err
		}
		if ref.LotID != nil {
			if _, err := s.q.LockBillingFundingLot(s.ctx, *ref.LotID); err != nil {
				return ref, s.acc, err
			}
			if err := s.releaseToLot(*ref.LotID, -e.AmountMinor); err != nil {
				return ref, s.acc, err
			}
		}
		if err := s.append(KindRefundReversal, -e.AmountMinor, "refund_release:"+ref.ID.String(), refs{lot: ref.LotID, refund: &ref.ID}, status); err != nil {
			return ref, s.acc, err
		}
		if err := s.settle(); err != nil {
			return ref, s.acc, err
		}
	}
	return ref, s.acc, s.save()
}

// Dispute outcomes (billing_disputes.outcome).
const (
	DisputeWon       = "won"
	DisputeLost      = "lost"
	DisputeWithdrawn = "withdrawn"
)

// DisputeReq is an opened dispute (chargeback) of a payment.
type DisputeReq struct {
	PaymentID         uuid.UUID
	ProviderDisputeID string
	Amount            int64
}

// OpenDispute records a dispute in the caller's transaction: the disputed money leaves the
// balance at once (first the lot's unused money, then what it paid becomes debt again), the
// account gets dispute_hold (no refunds / auto-topup) and the debt episode opens if the
// balance goes negative. A second call for the same dispute is a no-op.
func (c *Core) OpenDispute(ctx context.Context, q *sqlc.Queries, r DisputeReq) (sqlc.BillingDispute, sqlc.BillingAccount, error) {
	if err := positive(r.Amount); err != nil {
		return sqlc.BillingDispute{}, sqlc.BillingAccount{}, err
	}
	pay, err := q.GetBillingPayment(ctx, r.PaymentID)
	if err != nil {
		return sqlc.BillingDispute{}, sqlc.BillingAccount{}, err
	}
	s, err := c.lock(ctx, q, pay.AccountID, nil)
	if err != nil {
		return sqlc.BillingDispute{}, sqlc.BillingAccount{}, err
	}
	d, err := q.InsertBillingDispute(ctx, sqlc.InsertBillingDisputeParams{
		AccountID: s.acc.ID, PaymentID: pay.ID, ProviderDisputeID: r.ProviderDisputeID, AmountMinor: r.Amount, Currency: s.acc.Currency,
	})
	if db.IsNotFound(err) {
		d, err = q.GetBillingDisputeByProviderID(ctx, r.ProviderDisputeID)
		return d, s.acc, err
	}
	if err != nil {
		return d, s.acc, err
	}
	lot, err := q.LockBillingFundingLotByPayment(ctx, &pay.ID)
	if err != nil && !db.IsNotFound(err) {
		return d, s.acc, err
	}
	if err == nil {
		taken, err := s.clawback(lot, r.Amount)
		if err != nil {
			return d, s.acc, err
		}
		if err := s.append(KindDispute, -taken, "dispute:"+d.ID.String(), refs{lot: &lot.ID, dispute: &d.ID}, ""); err != nil {
			return d, s.acc, err
		}
		if err := s.afterTakeback(); err != nil {
			return d, s.acc, err
		}
	}
	if err := s.save(); err != nil {
		return d, s.acc, err
	}
	acc, err := q.SetBillingAccountDisputeHold(ctx, sqlc.SetBillingAccountDisputeHoldParams{DisputeHold: true, Now: s.now, ID: s.acc.ID})
	return d, acc, err
}

// CloseDispute records the outcome in the caller's transaction: won / withdrawn → the taken
// money goes back to its lot and the balance (paying debts first); lost → it stays taken. The
// dispute hold ends with the last open dispute. Closing a closed dispute is a no-op.
func (c *Core) CloseDispute(ctx context.Context, q *sqlc.Queries, providerDisputeID, outcome string) (sqlc.BillingDispute, sqlc.BillingAccount, error) {
	if outcome != DisputeWon && outcome != DisputeLost && outcome != DisputeWithdrawn {
		return sqlc.BillingDispute{}, sqlc.BillingAccount{}, httpx.Validation("outcome", "outcome must be won, lost or withdrawn")
	}
	d0, err := q.GetBillingDisputeByProviderID(ctx, providerDisputeID)
	if err != nil {
		return d0, sqlc.BillingAccount{}, err
	}
	s, err := c.lock(ctx, q, d0.AccountID, nil)
	if err != nil {
		return d0, sqlc.BillingAccount{}, err
	}
	d, err := q.LockBillingDisputeByProviderID(ctx, providerDisputeID)
	if err != nil || d.Status != "open" {
		return d, s.acc, err
	}
	if d, err = q.CloseBillingDispute(ctx, sqlc.CloseBillingDisputeParams{Outcome: &outcome, Now: s.now, ID: d.ID}); err != nil {
		return d, s.acc, err
	}
	if outcome != DisputeLost {
		e, err := q.GetBillingLedgerEntryByKey(ctx, "dispute:"+d.ID.String())
		if err != nil && !db.IsNotFound(err) {
			return d, s.acc, err
		}
		if err == nil && e.LotID != nil {
			if _, err := q.LockBillingFundingLot(ctx, *e.LotID); err != nil {
				return d, s.acc, err
			}
			if err := s.releaseToLot(*e.LotID, -e.AmountMinor); err != nil {
				return d, s.acc, err
			}
			if err := s.append(KindDisputeReversal, -e.AmountMinor, "dispute_reversal:"+d.ID.String(), refs{lot: e.LotID, dispute: &d.ID}, outcome); err != nil {
				return d, s.acc, err
			}
			if err := s.settle(); err != nil {
				return d, s.acc, err
			}
		}
	}
	if err := s.save(); err != nil {
		return d, s.acc, err
	}
	open, err := q.CountOpenBillingDisputes(ctx, s.acc.ID)
	if err != nil {
		return d, s.acc, err
	}
	acc, err := q.SetBillingAccountDisputeHold(ctx, sqlc.SetBillingAccountDisputeHoldParams{DisputeHold: open > 0, Now: s.now, ID: s.acc.ID})
	return d, acc, err
}
