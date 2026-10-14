package core

import (
	"context"
	"strings"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Refunds, the synchronous model (ADR-0080 / ADR-0083 amendment, owner 2026-10-10):
//   - an admin refund is recorded (StartRefund: nothing reserved), sent to the provider at once,
//     and booked when the provider executed it (ApplyRefundResult succeeded → the ledger entry);
//     refused → failed, nothing moved; unknown outcome → the one pending state, resolved by the
//     refund polling (executed → booked, absent → failed);
//   - a refund the bank executed without Calab (made in the bank's interface) is a fact: booked at
//     once (BookBankRefund), even into debt.
// Refundable of a payment = paid − refunded − pending without a reservation.

// RefundByHand reports whether a refund of pay is made only in the provider's own interface
// (provider.HandRefunder: Tochka subscription payments — a saved card's binding payment and its
// charges): the admin refund does not call the API, it shows what to refund in the bank.
func RefundByHand(ctx context.Context, q *sqlc.Queries, p provider.Provider, pay sqlc.BillingPayment) (bool, error) {
	hr, ok := p.(provider.HandRefunder)
	if !ok {
		return false, nil
	}
	if hr.RefundsByHand(pay.ProviderPaymentID, false) {
		return true, nil
	}
	binding, err := q.BillingPaymentIsSavedMethodBinding(ctx, sqlc.BillingPaymentIsSavedMethodBindingParams{
		Provider: pay.Provider, ProviderPaymentID: pay.ProviderPaymentID,
	})
	if err != nil {
		return false, err
	}
	return hr.RefundsByHand(pay.ProviderPaymentID, binding), nil
}

// takeRefund books an executed unreserved refund: its amount leaves the payment's lot (unused
// money first, then what it paid for becomes debt again) and the balance.
func (s *state) takeRefund(ref sqlc.BillingRefund) error {
	if ref.LotID == nil {
		return billing.ErrRefundExceedsRefundable
	}
	lot, err := s.q.LockBillingFundingLot(s.ctx, *ref.LotID)
	if err != nil {
		return err
	}
	taken, err := s.clawback(lot, ref.AmountMinor)
	if err != nil {
		return err
	}
	if err := s.append(KindRefund, -taken, "refund:"+ref.ID.String(), refs{lot: &lot.ID, refund: &ref.ID}, ref.Reason); err != nil {
		return err
	}
	return s.afterTakeback()
}

// StartRefund records an admin refund about to be sent to the provider, in the caller's
// transaction: nothing is reserved. amount ≤ refundable (paid − refunded − pending), else
// billing.ErrRefundExceedsRefundable; refused under a dispute (billing.ErrDisputeHold). The same
// IdemKey returns the existing row (another payment / amount → billing.ErrRequestReused).
func (c *Core) StartRefund(ctx context.Context, q *sqlc.Queries, r RefundReq) (sqlc.BillingRefund, sqlc.BillingAccount, error) {
	if err := positive(r.Amount); err != nil {
		return sqlc.BillingRefund{}, sqlc.BillingAccount{}, err
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
	if s.acc.DisputeHold {
		return sqlc.BillingRefund{}, s.acc, billing.ErrDisputeHold
	}
	lot, err := q.LockBillingFundingLotByPayment(ctx, &pay.ID)
	if db.IsNotFound(err) {
		return sqlc.BillingRefund{}, s.acc, billing.ErrRefundExceedsRefundable
	}
	if err != nil {
		return sqlc.BillingRefund{}, sqlc.BillingAccount{}, err
	}
	pending, err := q.SumUnreservedPendingBillingRefunds(ctx, pay.ID)
	if err != nil {
		return sqlc.BillingRefund{}, sqlc.BillingAccount{}, err
	}
	if r.Amount > lot.AmountMinor-lot.RefundedMinor-pending {
		return sqlc.BillingRefund{}, s.acc, billing.ErrRefundExceedsRefundable
	}
	ref, err := q.StartBillingRefund(ctx, sqlc.StartBillingRefundParams{
		AccountID: s.acc.ID, PaymentID: pay.ID, LotID: &lot.ID, AmountMinor: r.Amount, Currency: s.acc.Currency,
		IdemKey: r.IdemKey, Reason: r.Reason, RequestedBy: r.RequestedBy,
	})
	if db.IsNotFound(err) {
		return ref, s.acc, billing.ErrRequestReused
	}
	return ref, s.acc, err
}

// BookBankRefund books a refund the provider executed that no Calab refund claims (made in the
// provider's interface), in the caller's transaction with the account locked by the caller or
// not: on the preferred payment first (its own), then the payments of the same group (Tochka: the
// subscription's binding payment and charges, ids starting with group), then the account's other
// payments, as much as each can still return; the spent part becomes debt, the balance may go
// negative. The first part carries providerRefundID (the refund is claimed). More than every
// payment can return: billing.ErrRefundExceedsRefundable, nothing booked.
func (c *Core) BookBankRefund(ctx context.Context, q *sqlc.Queries, accountID uuid.UUID, preferred *uuid.UUID, group, providerRefundID string,
	amount int64, reason string, actor *uuid.UUID) ([]sqlc.BillingRefund, sqlc.BillingAccount, error) {
	rows, err := q.ListBillingPaymentsWithRefundRoom(ctx, accountID)
	if err != nil {
		return nil, sqlc.BillingAccount{}, err
	}
	rank := func(r sqlc.ListBillingPaymentsWithRefundRoomRow) int {
		switch {
		case preferred != nil && r.ID == *preferred:
			return 0
		case group != "" && (r.ProviderPaymentID == group || strings.HasPrefix(r.ProviderPaymentID, group+":")):
			return 1
		}
		return 2
	}
	var ordered []sqlc.ListBillingPaymentsWithRefundRoomRow
	var room int64
	for k := 0; k <= 2; k++ {
		for _, r := range rows {
			if rank(r) == k {
				ordered = append(ordered, r)
				room += r.Room
			}
		}
	}
	if room < amount {
		return nil, sqlc.BillingAccount{}, billing.ErrRefundExceedsRefundable
	}
	rest := amount
	var out []sqlc.BillingRefund
	var acc sqlc.BillingAccount
	for _, r := range ordered {
		if rest == 0 {
			break
		}
		take := min(rest, r.Room)
		key := "dashboard:" + providerRefundID
		var pid *string
		if len(out) == 0 {
			id := providerRefundID
			pid = &id
		} else {
			key += ":" + uuid.NewSHA1(uuid.NameSpaceOID, []byte(r.ID.String())).String()[:8]
		}
		ref, a, err := c.ReserveRefund(ctx, q, RefundReq{
			PaymentID: r.ID, Amount: take, IdemKey: key, Origin: RefundOriginDashboard, Status: RefundSucceeded,
			ProviderRefundID: pid, Reason: reason, RequestedBy: actor,
		})
		if err != nil {
			return nil, acc, err
		}
		out, acc, rest = append(out, ref), a, rest-take
	}
	return out, acc, nil
}
