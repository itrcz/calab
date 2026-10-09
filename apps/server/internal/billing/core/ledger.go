package core

import (
	"fmt"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Ledger kinds (billing_ledger.kind; the sign is fixed per kind by a CHECK).
const (
	KindTopup           = "topup"
	KindSeatCharge      = "seat_charge"
	KindCompensation    = "compensation"
	KindRefund          = "refund"
	KindRefundReversal  = "refund_reversal"
	KindDispute         = "dispute"
	KindDisputeReversal = "dispute_reversal"
	KindAdminCredit     = "admin_credit"
	KindAdminDebit      = "admin_debit"
)

// refs are the optional references of a ledger entry.
type refs struct {
	lot, charge, refund, dispute *uuid.UUID
}

// entryExists reports whether a ledger business key was written (a replayed command).
func (s *state) entryExists(key string) (bool, error) {
	_, err := s.q.GetBillingLedgerEntryByKey(s.ctx, key)
	if db.IsNotFound(err) {
		return false, nil
	}
	return err == nil, err
}

// append writes one ledger entry and moves the balance cache (the only balance mutation).
// A zero amount writes nothing. The caller checked the command's idempotency key already, so
// an existing key here is a bug and rolls the command back.
func (s *state) append(kind string, amount int64, key string, r refs, reason string) error {
	if amount == 0 {
		return nil
	}
	if ok, err := s.entryExists(key); err != nil {
		return err
	} else if ok {
		return fmt.Errorf("%w: %s", errDuplicateEntry, key)
	}
	e, err := s.q.AppendBillingLedgerEntry(s.ctx, sqlc.AppendBillingLedgerEntryParams{
		Kind: kind, AmountMinor: amount, BusinessKey: key, LotID: r.lot, ChargeID: r.charge, RefundID: r.refund,
		DisputeID: r.dispute, ActorID: s.actor, Reason: reason, Now: s.now, AccountID: s.acc.ID,
	})
	if err != nil {
		return fmt.Errorf("billing ledger %s: %w", kind, err)
	}
	s.acc.BalanceMinor, s.acc.EntrySeq = e.BalanceAfter, e.Seq
	s.acc.Revision++
	return nil
}

func lotFree(l sqlc.BillingFundingLot) int64 {
	return l.AmountMinor - l.ConsumedMinor - l.RefundedMinor
}

// part is the share of one funding lot in a charge.
type part struct {
	lot    int // index into the lots
	amount int64
}

// allocate splits amount over the free money of lots in FIFO order; rest is what they do not
// cover (debt of a renewal, or the reason to refuse a purchase).
func allocate(free []int64, amount int64) (parts []part, rest int64) {
	rest = amount
	for i, f := range free {
		if rest == 0 {
			break
		}
		if f <= 0 {
			continue
		}
		x := min(f, rest)
		parts = append(parts, part{lot: i, amount: x})
		rest -= x
	}
	return parts, rest
}

// openLots locks the funding lots with money left, oldest first.
func (s *state) openLots() ([]sqlc.BillingFundingLot, []int64, error) {
	lots, err := s.q.LockOpenBillingFundingLots(s.ctx, s.acc.ID)
	if err != nil {
		return nil, nil, err
	}
	free := make([]int64, len(lots))
	for i, l := range lots {
		free[i] = lotFree(l)
	}
	return lots, free, nil
}

// fund pays chargeID from the lots per parts (allocations + consumption).
func (s *state) fund(chargeID uuid.UUID, lots []sqlc.BillingFundingLot, parts []part) error {
	for _, p := range parts {
		if _, err := s.q.InsertBillingAllocation(s.ctx, sqlc.InsertBillingAllocationParams{
			AccountID: s.acc.ID, ChargeID: chargeID, LotID: lots[p.lot].ID, AmountMinor: p.amount,
		}); err != nil {
			return err
		}
		l, err := s.q.ConsumeBillingFundingLot(s.ctx, sqlc.ConsumeBillingFundingLotParams{Delta: p.amount, ID: lots[p.lot].ID})
		if err != nil {
			return err
		}
		lots[p.lot] = l
	}
	return nil
}

// normalize pays the oldest unpaid charges from the free advance (FIFO lots), so the account
// never holds free money and covered debt at once (ADR-0080 §5, §9). The balance is unchanged.
func (s *state) normalize() error {
	debts, err := s.q.LockUnfundedBillingCharges(s.ctx, s.acc.ID)
	if err != nil || len(debts) == 0 {
		return err
	}
	lots, free, err := s.openLots()
	if err != nil {
		return err
	}
	for _, ch := range debts {
		parts, rest := allocate(free, ch.UnfundedMinor)
		if len(parts) == 0 {
			break
		}
		if err := s.fund(ch.ID, lots, parts); err != nil {
			return err
		}
		for _, p := range parts {
			free[p.lot] -= p.amount
		}
		if _, err := s.q.FundBillingCharge(s.ctx, sqlc.FundBillingChargeParams{Delta: ch.UnfundedMinor - rest, ID: ch.ID}); err != nil {
			return err
		}
		if rest > 0 {
			break
		}
	}
	return nil
}

// freeAdvance is the money left on the funding lots.
func (s *state) freeAdvance() (int64, error) { return s.q.BillingFreeAdvance(s.ctx, s.acc.ID) }

// clawback takes up to amount back out of a funding lot (dispute, reversed credit, refund made
// outside Calab): first its free money, then what it paid for, the latest charge first — that
// part of the delivered service becomes debt again. The taken money is recorded as refunded on
// the lot. Returns the amount taken (less than amount only if the lot has less left).
func (s *state) clawback(lot sqlc.BillingFundingLot, amount int64) (int64, error) {
	amount = min(amount, lot.AmountMinor-lot.RefundedMinor)
	if amount <= 0 {
		return 0, nil
	}
	fromFree := min(lotFree(lot), amount)
	rest := amount - fromFree
	var fromCharges int64
	if rest > 0 {
		segs, err := s.q.ListBillingLotSegments(s.ctx, lot.ID)
		if err != nil {
			return 0, err
		}
		for _, seg := range segs {
			if rest == 0 {
				break
			}
			y := min(rest, seg.AmountMinor)
			if _, err := s.q.LockBillingCharge(s.ctx, seg.ChargeID); err != nil {
				return 0, err
			}
			if _, err := s.q.InsertBillingAllocation(s.ctx, sqlc.InsertBillingAllocationParams{
				AccountID: s.acc.ID, ChargeID: seg.ChargeID, LotID: lot.ID, AmountMinor: -y,
			}); err != nil {
				return 0, err
			}
			if _, err := s.q.UnfundBillingCharge(s.ctx, sqlc.UnfundBillingChargeParams{Delta: y, ID: seg.ChargeID}); err != nil {
				return 0, err
			}
			rest -= y
			fromCharges += y
		}
		if fromCharges > 0 {
			if _, err := s.q.ConsumeBillingFundingLot(s.ctx, sqlc.ConsumeBillingFundingLotParams{Delta: -fromCharges, ID: lot.ID}); err != nil {
				return 0, err
			}
		}
	}
	taken := fromFree + fromCharges
	if taken > 0 {
		if _, err := s.q.RefundBillingFundingLot(s.ctx, sqlc.RefundBillingFundingLotParams{Delta: taken, ID: lot.ID}); err != nil {
			return 0, err
		}
	}
	return taken, nil
}

// releaseToLot puts amount back on a lot that clawback / a refund reservation took it from;
// normalize afterwards pays debts with it.
func (s *state) releaseToLot(lotID uuid.UUID, amount int64) error {
	if amount <= 0 {
		return nil
	}
	_, err := s.q.RefundBillingFundingLot(s.ctx, sqlc.RefundBillingFundingLotParams{Delta: -amount, ID: lotID})
	return err
}
