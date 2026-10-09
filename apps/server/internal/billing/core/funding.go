package core

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Funding lot sources (billing_funding_lots.source).
const (
	SourcePayment     = "payment"
	SourceAdminCredit = "admin_credit"
)

// ErrPaymentNotCreditable means the payment row is not a succeeded payment of the account's
// currency (the caller verifies the provider fact before; this is the last guard).
var ErrPaymentNotCreditable = errors.New("billing core: payment is not creditable")

// CreditPayment credits a verified, succeeded billing_payments row in the caller's transaction
// (T5 inbox: insert / mark the payment succeeded, then this, then commit). It locks the account,
// applies what was due up to the payment time (a payment after the deadline does not undo the
// suspension: receipt barrier), creates the payment's funding lot and the top-up entry, pays
// the debt oldest charge first, applies what is due up to now and closes the debt episode if
// the balance is not negative. A second call for the same payment is a no-op (one lot per
// payment). Returns the account; the caller notifies after its commit.
func (c *Core) CreditPayment(ctx context.Context, q *sqlc.Queries, paymentID uuid.UUID) (sqlc.BillingAccount, error) {
	s, err := c.creditPayment(ctx, q, paymentID)
	if err != nil {
		return sqlc.BillingAccount{}, err
	}
	return s.acc, nil
}

// CreditPaymentTx is CreditPayment in its own transaction (Hooks.Committed runs after it).
func (c *Core) CreditPaymentTx(ctx context.Context, paymentID uuid.UUID) (sqlc.BillingAccount, error) {
	var s *state
	err := c.db.Tx(ctx, func(q *sqlc.Queries) error {
		var err error
		s, err = c.creditPayment(ctx, q, paymentID)
		return err
	})
	if err != nil {
		return sqlc.BillingAccount{}, err
	}
	c.committed(ctx, s)
	return s.acc, nil
}

func (c *Core) creditPayment(ctx context.Context, q *sqlc.Queries, paymentID uuid.UUID) (*state, error) {
	pay, err := q.GetBillingPayment(ctx, paymentID)
	if err != nil {
		return nil, err
	}
	s, err := c.lock(ctx, q, pay.AccountID, nil)
	if err != nil {
		return nil, err
	}
	if pay.Status != "succeeded" || pay.SucceededAt == nil || pay.Currency != s.acc.Currency || pay.AmountMinor <= 0 {
		return nil, fmt.Errorf("%w: %s (%s %s)", ErrPaymentNotCreditable, pay.ID, pay.Status, pay.Currency)
	}
	if _, err := q.LockBillingFundingLotByPayment(ctx, &pay.ID); err == nil {
		return s, nil // credited already
	} else if !db.IsNotFound(err) {
		return nil, err
	}
	barrier := s.now
	if pay.SucceededAt.Before(barrier) {
		barrier = pay.SucceededAt.UTC()
	}
	if _, err := s.catchUp(barrier); err != nil {
		return nil, err
	}
	lot, err := q.InsertBillingFundingLot(ctx, sqlc.InsertBillingFundingLotParams{
		AccountID: s.acc.ID, Source: SourcePayment, PaymentID: &pay.ID, AmountMinor: pay.AmountMinor,
	})
	if err != nil {
		return nil, err
	}
	if err := s.append(KindTopup, pay.AmountMinor, "topup:"+pay.ID.String(), refs{lot: &lot.ID}, ""); err != nil {
		return nil, err
	}
	if err := s.settle(); err != nil {
		return nil, err
	}
	return s, s.save()
}

// settle runs after money came in: pay debts, apply what is due, close the episode.
func (s *state) settle() error {
	if err := s.normalize(); err != nil {
		return err
	}
	if _, err := s.catchUp(s.now); err != nil {
		return err
	}
	s.closeEpisodeIfPaid()
	return nil
}

func positive(amount int64) error {
	if amount <= 0 {
		return httpx.Validation("amount", "amount must be positive")
	}
	return nil
}

// AdminCredit (superadmin) adds money that did not come from a payment: an admin_credit lot,
// spent FIFO like any other but never refunded as cash. requestID makes a retry a no-op.
// Returns the lot id.
func (c *Core) AdminCredit(ctx context.Context, accountID uuid.UUID, amount int64, reason string, requestID uuid.UUID, actor *uuid.UUID) (uuid.UUID, error) {
	if err := positive(amount); err != nil {
		return uuid.Nil, err
	}
	var lotID uuid.UUID
	_, err := c.run(ctx, accountID, actor, func(s *state) error {
		key := "admin_credit:" + requestID.String()
		if e, err := s.q.GetBillingLedgerEntryByKey(s.ctx, key); err == nil {
			if e.AccountID != s.acc.ID || e.AmountMinor != amount || e.LotID == nil {
				return billing.ErrRequestReused
			}
			lotID = *e.LotID
			return nil
		} else if !db.IsNotFound(err) {
			return err
		}
		lot, err := s.q.InsertBillingFundingLot(s.ctx, sqlc.InsertBillingFundingLotParams{
			AccountID: s.acc.ID, Source: SourceAdminCredit, AmountMinor: amount, ActorID: s.actor, Reason: reason,
		})
		if err != nil {
			return err
		}
		lotID = lot.ID
		if err := s.append(KindAdminCredit, amount, key, refs{lot: &lot.ID}, reason); err != nil {
			return err
		}
		return s.settle()
	})
	return lotID, err
}

// AdminDebit (superadmin) takes money off the free advance (FIFO lots) as a correction; it
// never creates debt (billing.ErrInsufficientFunds). requestID makes a retry a no-op.
func (c *Core) AdminDebit(ctx context.Context, accountID uuid.UUID, amount int64, reason string, requestID uuid.UUID, actor *uuid.UUID) (sqlc.BillingAccount, error) {
	if err := positive(amount); err != nil {
		return sqlc.BillingAccount{}, err
	}
	return c.run(ctx, accountID, actor, func(s *state) error {
		key := "admin_debit:" + requestID.String()
		if e, err := s.q.GetBillingLedgerEntryByKey(s.ctx, key); err == nil {
			if e.AccountID != s.acc.ID || e.AmountMinor != -amount {
				return billing.ErrRequestReused
			}
			return nil
		} else if !db.IsNotFound(err) {
			return err
		}
		lots, free, err := s.openLots()
		if err != nil {
			return err
		}
		parts, rest := allocate(free, amount)
		if rest > 0 {
			return billing.ErrInsufficientFunds
		}
		for _, p := range parts {
			if _, err := s.q.ConsumeBillingFundingLot(s.ctx, sqlc.ConsumeBillingFundingLotParams{Delta: p.amount, ID: lots[p.lot].ID}); err != nil {
				return err
			}
		}
		return s.append(KindAdminDebit, -amount, key, refs{}, reason)
	})
}

// ReverseAdminCredit (superadmin) takes a manual credit back in full: its unused money first,
// then what it already paid for becomes debt again (the episode opens if the balance goes
// negative). Once per lot (ErrCreditAlreadyReversed). Returns the amount taken back.
func (c *Core) ReverseAdminCredit(ctx context.Context, lotID uuid.UUID, reason string, actor *uuid.UUID) (int64, error) {
	var taken int64
	find := func(q *sqlc.Queries) (uuid.UUID, error) {
		lot, err := q.GetBillingFundingLot(ctx, lotID)
		if db.IsNotFound(err) {
			return uuid.Nil, httpx.NotFound("credit")
		}
		return lot.AccountID, err
	}
	_, err := c.runOn(ctx, actor, find, func(s *state) error {
		lot, err := s.q.LockBillingFundingLot(s.ctx, lotID)
		if err != nil {
			return err
		}
		if lot.Source != SourceAdminCredit {
			return httpx.Validation("lot", "only a manual credit can be reversed")
		}
		key := "admin_reverse:" + lot.ID.String()
		if ok, err := s.entryExists(key); err != nil {
			return err
		} else if ok {
			return ErrCreditAlreadyReversed
		}
		if taken, err = s.clawback(lot, lot.AmountMinor-lot.RefundedMinor); err != nil {
			return err
		}
		if err := s.append(KindAdminDebit, -taken, key, refs{lot: &lot.ID}, reason); err != nil {
			return err
		}
		return s.afterTakeback()
	})
	return taken, err
}

// afterTakeback runs after money left the balance without a service (dispute, reversed
// credit, refund made outside Calab): pay debts from what is left, open the episode now if
// the balance is negative.
func (s *state) afterTakeback() error {
	if err := s.normalize(); err != nil {
		return err
	}
	s.openEpisode(s.now)
	s.closeEpisodeIfPaid()
	return nil
}
